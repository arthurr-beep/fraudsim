/**
 * Scenario: sim-swap-takeover
 *
 * The attacker does not break the authentication — they redirect it. By
 * socially engineering or bribing a telco into porting the victim's number to a
 * SIM they control, every SMS OTP now arrives on the attacker's handset. Then
 * they walk through the front door: password reset, OTP confirmed, login,
 * withdrawal.
 *
 * Every individual step passes. The password reset is confirmed by a real OTP.
 * The login satisfies two factors. The withdrawal comes from an authenticated,
 * verified session. The only thing wrong is that the second factor stopped
 * belonging to the customer a few minutes ago.
 *
 * Defensive systems should catch this via:
 *   - Telco porting check      (number ported within N days → distrust SMS OTP)
 *   - OTP-to-new-device        (second factor confirmed on an unseen handset)
 *   - Login-immediately-after-port heuristic
 *   - Step-up escalation       (fall back to a factor the attacker cannot port)
 *
 * This scenario is the strongest argument for treating SMS OTP as a signal
 * rather than proof. A system relying on OTP alone will pass every stage.
 */

import { sleep } from '../utils/sleep.js';
import {
  buildLoginPayload,
  buildWithdrawalPayload,
  buildActionPayload,
  newDeviceFingerprint,
  newSessionId,
} from '../utils/faker-helpers.js';
import { newResults, scoreAndCount } from '../utils/results.js';
import { simulatedClock, humaniseMs } from '../utils/clock.js';
import { randomPhoneNumber, randomIp, pickDemoIp } from '../utils/random.js';

export default {
  id: 'sim-swap-takeover',
  name: 'SIM swap takeover',
  description:
    "The victim's number is ported to the attacker's SIM, redirecting OTPs; the attacker then resets the password, logs in, and withdraws.",

  defaultOptions: {
    targetUserId: null, // required
    minutesSincePort: 20, // how recently the number was ported
    amountKobo: 40000000, // NGN 400,000 — SIM swaps target high-value accounts
    reportPortEvent: true, // tell the target about the port, if it accepts one
    attemptPasswordReset: true,
    ipPersona: 'domestic', // SIM swappers are usually in-country
    delayMs: 200,
  },

  async run(ctx) {
    const { options, emit, signal } = ctx;

    if (!options.targetUserId) {
      throw new Error('sim-swap-takeover requires options.targetUserId');
    }

    const results = newResults({
      stages: [], // ordered record of what happened at each step
      blockedAtStage: null,
      resetDecision: null,
      loginDecision: null,
      withdrawalDecision: null,
    });

    const clock = simulatedClock({ start: Date.now() });
    const portedAt = new Date(clock.epoch() - options.minutesSincePort * 60_000).toISOString();

    const attacker = {
      device: newDeviceFingerprint(), // a handset the account has never seen
      ip: pickIp(options.ipPersona),
      session: newSessionId('swap'),
      phone: randomPhoneNumber(),
    };

    const record = (stage, decision) => {
      results.stages.push({ stage, decision: decision ?? 'ERROR' });
      if ((decision === 'BLOCK' || decision === 'STEP_UP') && results.blockedAtStage == null) {
        results.blockedAtStage = stage;
      }
    };

    emit({
      type: 'milestone',
      message:
        `Number ported to the attacker's SIM ${humaniseMs(options.minutesSincePort * 60_000)} ago — ` +
        'all SMS OTPs now arrive on their handset',
      timestamp: Date.now(),
    });

    // ── Stage 0: tell the target the number was ported ──────────────────
    // A system integrated with a telco porting feed would already know. Systems
    // that accept the signal from the fintech need to be told.
    if (options.reportPortEvent && typeof ctx.target.reportEvent === 'function') {
      try {
        await ctx.target.reportEvent('sim-swap', {
          user_id: options.targetUserId,
          ported_at: portedAt,
          new_msisdn: attacker.phone,
          metadata: { _simulated: true },
        });
      } catch {
        // Not every target models this. The attack proceeds either way.
      }
    }

    // ── Stage 1: password reset, confirmed by the redirected OTP ────────
    if (options.attemptPasswordReset) {
      const reset = await scoreAndCount({
        ctx,
        method: 'scoreAction',
        payload: buildActionPayload(
          options.targetUserId,
          'password_reset',
          {
            confirmed_by: 'sms_otp',
            otp_delivered_to: attacker.phone,
            msisdn_ported_at: portedAt,
          },
          {
            session_id: attacker.session,
            device_fingerprint: attacker.device,
            ip_address: attacker.ip.ip,
            timestamp: clock.iso(),
          }
        ),
        results,
        stage: 'password-reset',
        ipIntel: attacker.ip.intel,
      });

      results.resetDecision = reset?.decision ?? null;
      record('password-reset', reset?.decision);

      if (reset?.decision === 'BLOCK') {
        emit({
          type: 'milestone',
          message: 'Password reset blocked — the port was treated as disqualifying the OTP',
          timestamp: Date.now(),
        });
        return finalise(results, options, clock);
      }

      clock.advance(3 * 60_000);
      try {
        await sleep(options.delayMs, signal);
      } catch {
        return finalise(results, options, clock);
      }
    }

    // ── Stage 2: login from the attacker's handset ──────────────────────
    const login = await scoreAndCount({
      ctx,
      method: 'scoreLogin',
      payload: buildLoginPayload(options.targetUserId, {
        session_id: attacker.session,
        device_fingerprint: attacker.device,
        ip_address: attacker.ip.ip,
        timestamp: clock.iso(),
        metadata: {
          login_method: 'sms_otp',
          platform: 'android',
          msisdn_ported_at: portedAt,
          _simulated: true,
        },
      }),
      results,
      stage: 'login',
      ipIntel: attacker.ip.intel,
    });

    results.loginDecision = login?.decision ?? null;
    record('login', login?.decision);

    if (login?.decision === 'BLOCK') {
      emit({
        type: 'milestone',
        message: 'Login blocked — new device plus a recent port was enough',
        timestamp: Date.now(),
      });
      return finalise(results, options, clock);
    }

    clock.advance(2 * 60_000);
    try {
      await sleep(options.delayMs, signal);
    } catch {
      return finalise(results, options, clock);
    }

    // ── Stage 3: immediate high-value withdrawal ────────────────────────
    emit({
      type: 'milestone',
      message: `Withdrawing NGN ${(options.amountKobo / 100).toLocaleString()} minutes after the port`,
      timestamp: Date.now(),
    });

    const withdrawal = await scoreAndCount({
      ctx,
      method: 'scoreWithdrawal',
      payload: buildWithdrawalPayload(
        options.targetUserId,
        { amount: options.amountKobo },
        {
          session_id: attacker.session,
          device_fingerprint: attacker.device,
          ip_address: attacker.ip.ip,
          timestamp: clock.iso(),
        }
      ),
      results,
      stage: 'withdrawal',
      ipIntel: attacker.ip.intel,
    });

    results.withdrawalDecision = withdrawal?.decision ?? null;
    record('withdrawal', withdrawal?.decision);

    if (withdrawal?.decision === 'ALLOW') {
      emit({
        type: 'milestone',
        message:
          'Withdrawal allowed. Every stage was confirmed by an OTP the attacker received — ' +
          'SMS as proof of identity is the whole vulnerability here.',
        timestamp: Date.now(),
      });
    }

    return finalise(results, options, clock);
  },
};

function pickIp(persona) {
  if (!persona || persona === 'random') return { ip: randomIp(), intel: undefined };
  const { ip, ...intel } = pickDemoIp(persona);
  return { ip, intel };
}

function finalise(results, options, clock) {
  const succeeded = results.withdrawalDecision === 'ALLOW';
  return {
    ...results,
    attackerSucceeded: succeeded,
    estimatedLossKobo: succeeded ? options.amountKobo : 0,
    // Which stage first pushed back. `null` means the whole chain succeeded.
    blockedAtStage: results.blockedAtStage,
    simulatedTime: true,
    simulatedSpan: humaniseMs(clock.elapsedMs()),
  };
}
