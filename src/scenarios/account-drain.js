/**
 * Scenario: account-drain
 *
 * An attacker who has obtained valid credentials logs in from a new device,
 * changes the password to lock out the legitimate user, and rapidly drains
 * the account through withdrawals to new payees.
 *
 * Defensive systems should catch this via:
 *   - NEW_DEVICE                      (login from unknown device)
 *   - WITHDRAWAL_AFTER_PWD_CHANGE     (withdrawal soon after password reset)
 *   - DEVICE_SESSION_MISMATCH         (device changed mid-session)
 *   - NEW_PAYEE_HIGH_AMOUNT           (first transaction to new payee, high amount)
 *   - DRAIN_PATTERN                   (multiple new payees in short window)
 *
 * Realistic outcomes:
 *   - Login itself may STEP_UP (NEW_DEVICE)
 *   - First withdrawal: STEP_UP or BLOCK depending on amount
 *   - Drain pattern detection should BLOCK by the 3rd withdrawal
 */

import { sleep } from '../utils/sleep.js';
import {
  buildLoginPayload,
  buildWithdrawalPayload,
  newSessionId,
  newDeviceFingerprint,
} from '../utils/faker-helpers.js';
import { randomIp } from '../utils/random.js';

export default {
  id: 'account-drain',
  name: 'Account takeover and drain',
  description:
    'Attacker logs in from a new device, changes the password, and rapidly drains funds to new payees.',

  defaultOptions: {
    targetUserId: null, // required
    attackerIp: null, // optional — random if not provided
    withdrawalCount: 5,
    // NGN 120,000 per withdrawal, in kobo.
    //
    // Calibration: rule engines commonly gate "new payee, high amount" near
    // NGN 50,000 and "large amount from a new device" near NGN 100,000 — the
    // latter often as a hard block. A default below both means the drain runs
    // to completion against a correctly configured system and the run reports
    // a failure that is really just an under-powered attack. Lower this to
    // find where a specific target's amount thresholds actually sit.
    amountKobo: 12000000,
    delayBetweenWithdrawalsMs: 15000, // 15 seconds
    postLoginPauseMs: 30000, // 30 seconds — attackers move fast after password change
    skipPasswordChange: false,
  },

  async run(ctx) {
    const { options, target, emit, signal } = ctx;

    if (!options.targetUserId) {
      throw new Error('account-drain requires options.targetUserId');
    }

    const results = {
      attempts: 0,
      blocked: 0,
      stepUp: 0,
      allowed: 0,
      errors: 0,
      loginDecision: null,
      withdrawalDecisions: [],
      attackerSucceeded: false,
    };

    const attackerIp = options.attackerIp ?? randomIp();
    const attackerDevice = newDeviceFingerprint();
    const sessionId = newSessionId('drain');

    // ── Step 1: login from new device ─────────────────────────────────
    emit({
      type: 'milestone',
      message: `Attacker attempts login from new device (IP: ${attackerIp})`,
      timestamp: Date.now(),
    });

    const loginPayload = buildLoginPayload(options.targetUserId, {
      session_id: sessionId,
      ip_address: attackerIp,
      device_fingerprint: attackerDevice,
      user_agent: 'Mozilla/5.0 (Linux; Android 13; SM-A546B)',
    });

    const t0 = Date.now();
    emit({ type: 'attempt', round: 0, payload: loginPayload, timestamp: t0 });

    let loginResponse;
    try {
      loginResponse = await target.scoreLogin(loginPayload);
    } catch (err) {
      results.errors++;
      emit({
        type: 'error',
        message: `Login attempt failed: ${err.message}`,
        timestamp: Date.now(),
      });
      return finalise(results);
    }

    emit({
      type: 'response',
      round: 0,
      response: loginResponse,
      latencyMs: Date.now() - t0,
      timestamp: Date.now(),
    });

    results.attempts++;
    results.loginDecision = loginResponse.decision;
    incrementCount(results, loginResponse.decision);

    if (loginResponse.decision === 'BLOCK') {
      emit({
        type: 'milestone',
        message: 'Login blocked — attacker cannot proceed',
        timestamp: Date.now(),
      });
      return finalise(results);
    }

    // ── Step 2: change password (simulated — reported to target) ──────
    if (!options.skipPasswordChange) {
      emit({
        type: 'milestone',
        message: 'Attacker changes password to lock out the legitimate user',
        timestamp: Date.now(),
      });

      try {
        await target.reportEvent('password-changed', {
          user_id: options.targetUserId,
          changed_at: new Date().toISOString(),
          metadata: { _simulated: true },
        });
      } catch {
        // Non-critical — some targets won't support this endpoint
      }
    }

    // Realistic attackers move fast after a password change
    try {
      await sleep(options.postLoginPauseMs, signal);
    } catch {
      return finalise(results);
    }

    // ── Step 3: rapid withdrawals to new payees ───────────────────────
    emit({
      type: 'milestone',
      message: `Attacker attempts ${options.withdrawalCount} rapid withdrawals to new payees`,
      timestamp: Date.now(),
    });

    for (let i = 0; i < options.withdrawalCount; i++) {
      if (signal.aborted) break;

      const wdPayload = buildWithdrawalPayload(
        options.targetUserId,
        {
          amount: options.amountKobo,
          is_new_payee: true,
        },
        {
          session_id: sessionId,
          ip_address: attackerIp,
          device_fingerprint: attackerDevice,
        }
      );

      const wt0 = Date.now();
      emit({
        type: 'attempt',
        round: results.attempts,
        payload: wdPayload,
        timestamp: wt0,
      });

      let wdResponse;
      try {
        wdResponse = await target.scoreWithdrawal(wdPayload);
      } catch (err) {
        results.errors++;
        emit({
          type: 'error',
          message: `Withdrawal ${i + 1} failed: ${err.message}`,
          timestamp: Date.now(),
        });
        continue;
      }

      emit({
        type: 'response',
        round: results.attempts,
        response: wdResponse,
        latencyMs: Date.now() - wt0,
        timestamp: Date.now(),
      });

      results.attempts++;
      results.withdrawalDecisions.push({
        index: i + 1,
        decision: wdResponse.decision,
        reasons: wdResponse.reasons,
      });
      incrementCount(results, wdResponse.decision);

      // Stop draining once any withdrawal is blocked — a real attacker would
      // realise the system has noticed and pivot or abandon
      if (wdResponse.decision === 'BLOCK') {
        emit({
          type: 'milestone',
          message: `Withdrawal ${i + 1} blocked — attacker gives up`,
          timestamp: Date.now(),
        });
        break;
      }

      // If all withdrawals succeed, the attacker has fully drained the account
      if (i === options.withdrawalCount - 1 && wdResponse.decision === 'ALLOW') {
        results.attackerSucceeded = true;
        emit({
          type: 'milestone',
          message: 'All withdrawals succeeded — account fully drained',
          timestamp: Date.now(),
        });
      }

      try {
        await sleep(options.delayBetweenWithdrawalsMs, signal);
      } catch {
        break;
      }
    }

    return finalise(results);
  },
};

function incrementCount(results, decision) {
  if (decision === 'BLOCK') results.blocked++;
  else if (decision === 'STEP_UP') results.stepUp++;
  else if (decision === 'ALLOW') results.allowed++;
  else results.errors++;
}

function finalise(results) {
  return {
    attempts: results.attempts,
    blocked: results.blocked,
    stepUp: results.stepUp,
    allowed: results.allowed,
    errors: results.errors,
    loginDecision: results.loginDecision,
    withdrawalDecisions: results.withdrawalDecisions,
    attackerSucceeded: results.attackerSucceeded,
  };
}
