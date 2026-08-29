/**
 * Scenario: session-hijack
 *
 * The victim logs in legitimately. Everything about that login is clean — their
 * usual device, their usual network, their usual hour. Then the session token
 * is stolen (malware, an XSS payload, a shoulder-surfed cookie, a proxy on a
 * hostile network) and replayed from somewhere else.
 *
 * The attacker never authenticates. There is no failed login, no new-device
 * login event, no password reset — none of the signals an account-takeover rule
 * watches for. From the login endpoint's perspective, nothing happened.
 *
 * Defensive systems should catch this via:
 *   - Session continuity checks   (device at action vs device at login)
 *   - IP continuity within session
 *   - Impossible travel within a single session
 *   - Re-authentication on sensitive actions regardless of session age
 *
 * This scenario exists to test one specific claim: that the system scores the
 * *session*, not just the login. A system that only scores logins will let the
 * withdrawal through and report a perfect block rate on the login endpoint.
 */

import { sleep } from '../utils/sleep.js';
import {
  buildLoginPayload,
  buildWithdrawalPayload,
  buildActionPayload,
  newSessionId,
  newDeviceFingerprint,
} from '../utils/faker-helpers.js';
import { newResults, scoreAndCount } from '../utils/results.js';
import { randomIp, pickDemoIp, randomUserAgent } from '../utils/random.js';

export default {
  id: 'session-hijack',
  name: 'Session hijack',
  description:
    "The victim logs in normally; the session token is then replayed from a different device and network to move funds.",

  defaultOptions: {
    targetUserId: null, // required
    benignActionsBeforeHijack: 2, // the victim's own activity first
    amountKobo: 20000000, // NGN 200,000 once the session is stolen
    withdrawAfterHijack: true,
    hijackFromPersona: 'foreign', // where the stolen session is replayed from
    delayMs: 150,
  },

  async run(ctx) {
    const { options, emit, signal } = ctx;

    if (!options.targetUserId) {
      throw new Error('session-hijack requires options.targetUserId');
    }

    const results = newResults({
      loginDecision: null,
      hijackedActionDecision: null,
      withdrawalDecision: null,
      hijackDetected: false,
    });

    // The victim's genuine context, stable across the legitimate part.
    const sessionId = newSessionId('sess');
    const victim = {
      device: newDeviceFingerprint(),
      ip: pickIp('domestic'),
      userAgent: randomUserAgent(),
    };

    // ── Stage 1: the victim's own, entirely legitimate login ────────────
    emit({
      type: 'milestone',
      message: 'Victim logs in normally — usual device, usual network',
      timestamp: Date.now(),
    });

    const login = await scoreAndCount({
      ctx,
      method: 'scoreLogin',
      payload: buildLoginPayload(options.targetUserId, {
        session_id: sessionId,
        device_fingerprint: victim.device,
        ip_address: victim.ip.ip,
        user_agent: victim.userAgent,
      }),
      results,
      stage: 'victim-login',
      ipIntel: victim.ip.intel,
    });

    results.loginDecision = login?.decision ?? null;

    if (login?.decision === 'BLOCK') {
      emit({
        type: 'milestone',
        message:
          'The victim\'s own login was blocked. That is a false positive, not a defence — ' +
          'the hijack has not happened yet.',
        timestamp: Date.now(),
      });
      return finalise(results, false);
    }

    // ── Stage 2: ordinary in-session activity by the real user ──────────
    for (let i = 0; i < options.benignActionsBeforeHijack; i++) {
      if (signal.aborted) break;

      await scoreAndCount({
        ctx,
        method: 'scoreAction',
        payload: buildActionPayload(
          options.targetUserId,
          'view_balance',
          {},
          {
            session_id: sessionId,
            device_fingerprint: victim.device,
            ip_address: victim.ip.ip,
            user_agent: victim.userAgent,
          }
        ),
        results,
        stage: 'victim-activity',
      });

      try {
        await sleep(options.delayMs, signal);
      } catch {
        break;
      }
    }

    // ── Stage 3: the session is stolen and replayed elsewhere ───────────
    const attacker = {
      device: newDeviceFingerprint(),
      ip: pickIp(options.hijackFromPersona),
      userAgent: randomUserAgent(),
    };

    emit({
      type: 'milestone',
      message:
        `Session ${sessionId} replayed from a different device and network ` +
        `(${attacker.ip.intel?.country ?? attacker.ip.ip}) — no new login, no password change`,
      timestamp: Date.now(),
    });

    const hijackedAction = await scoreAndCount({
      ctx,
      method: 'scoreAction',
      payload: buildActionPayload(
        options.targetUserId,
        'view_balance',
        {},
        {
          session_id: sessionId, // the one thing that did not change
          device_fingerprint: attacker.device,
          ip_address: attacker.ip.ip,
          user_agent: attacker.userAgent,
        }
      ),
      results,
      stage: 'hijacked-action',
      ipIntel: attacker.ip.intel,
    });

    results.hijackedActionDecision = hijackedAction?.decision ?? null;
    if (hijackedAction?.decision === 'BLOCK' || hijackedAction?.decision === 'STEP_UP') {
      results.hijackDetected = true;
      emit({
        type: 'milestone',
        message: `Session continuity break detected at the first hijacked action (${hijackedAction.decision})`,
        timestamp: Date.now(),
      });
    }

    // ── Stage 4: cash out on the stolen session ─────────────────────────
    if (!options.withdrawAfterHijack || signal.aborted) {
      return finalise(results, results.hijackDetected);
    }

    const withdrawal = await scoreAndCount({
      ctx,
      method: 'scoreWithdrawal',
      payload: buildWithdrawalPayload(
        options.targetUserId,
        { amount: options.amountKobo },
        {
          session_id: sessionId,
          device_fingerprint: attacker.device,
          ip_address: attacker.ip.ip,
        }
      ),
      results,
      stage: 'hijacked-withdrawal',
      ipIntel: attacker.ip.intel,
    });

    results.withdrawalDecision = withdrawal?.decision ?? null;
    if (withdrawal?.decision === 'BLOCK' || withdrawal?.decision === 'STEP_UP') {
      results.hijackDetected = true;
    }

    if (withdrawal?.decision === 'ALLOW') {
      emit({
        type: 'milestone',
        message:
          `Withdrawal of NGN ${(options.amountKobo / 100).toLocaleString()} allowed on a session ` +
          'whose device and network both changed mid-flight — session continuity is not being scored',
        timestamp: Date.now(),
      });
    }

    return finalise(results, results.hijackDetected, options.amountKobo);
  },
};

function pickIp(persona) {
  if (!persona || persona === 'random') return { ip: randomIp(), intel: undefined };
  const { ip, ...intel } = pickDemoIp(persona);
  return { ip, intel };
}

function finalise(results, detected, amountKobo = 0) {
  const succeeded = results.withdrawalDecision === 'ALLOW';
  return {
    ...results,
    hijackDetected: detected,
    attackerSucceeded: succeeded,
    estimatedLossKobo: succeeded ? amountKobo : 0,
  };
}
