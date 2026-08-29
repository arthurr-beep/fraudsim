/**
 * Scenario: slow-drain
 *
 * The patient version of an account takeover. Instead of emptying an account in
 * minutes, the attacker withdraws small amounts spaced far enough apart that no
 * short-window velocity rule ever trips. Over days the account is emptied
 * anyway.
 *
 * This is the scenario that separates systems with a real baseline from systems
 * with a counter. Any engine can catch five withdrawals in a minute. Catching
 * twenty withdrawals over four days — each individually ordinary, but ten times
 * the account's normal weekly outflow — requires knowing what normal is.
 *
 * Defensive systems should catch this via:
 *   - Multi-window velocity     (hourly AND daily AND weekly counters)
 *   - Baseline deviation        (this user does not usually behave like this)
 *   - Cumulative amount rules   (total moved since a trust event)
 *   - Payee-diversity anomalies (many new destinations over a long window)
 *
 * ── On simulated time ─────────────────────────────────────────────────
 * A real slow drain takes days, so this scenario advances the `timestamp` field
 * rather than sleeping. That is faithful only if the target derives its windows
 * from the event timestamp. A system that stamps arrival time server-side will
 * see one compressed burst and block it for the wrong reason — a pass here
 * would be meaningless. The report sets `simulatedTime: true` so this is never
 * silently assumed.
 */

import { sleep } from '../utils/sleep.js';
import {
  buildWithdrawalPayload,
  newDeviceFingerprint,
  newSessionId,
} from '../utils/faker-helpers.js';
import { newResults, scoreAndCount } from '../utils/results.js';
import { simulatedClock, humaniseMs } from '../utils/clock.js';
import { randomIp, randomInt } from '../utils/random.js';

export default {
  id: 'slow-drain',
  name: 'Slow drain below velocity thresholds',
  description:
    'Withdrawals individually below every short-window threshold, spaced over days, that collectively empty the account.',

  defaultOptions: {
    targetUserId: null, // required
    withdrawalCount: 20,
    amountKobo: 2500000, // NGN 25,000 — deliberately modest
    amountJitterKobo: 500000, // vary amounts so they don't look scripted
    intervalMinutes: 300, // 5 simulated hours between withdrawals
    sameDevice: true, // a patient attacker keeps one stable device
    delayMs: 60, // wall-clock pacing only
    maxTotalAttempts: 100,
  },

  async run(ctx) {
    const { options, emit, signal } = ctx;

    if (!options.targetUserId) {
      throw new Error('slow-drain requires options.targetUserId');
    }
    if (options.intervalMinutes <= 0) {
      throw new Error('slow-drain requires options.intervalMinutes > 0');
    }

    const results = newResults({
      withdrawalsAttempted: 0,
      drainedKobo: 0,
      firstBlockedAtWithdrawal: null,
      firstStepUpAtWithdrawal: null,
    });

    const clock = simulatedClock({
      start: Date.now(),
      stepMs: options.intervalMinutes * 60_000,
    });

    // A patient attacker is not rotating infrastructure — that would create the
    // very novelty signals they are trying to avoid.
    const device = options.sameDevice ? newDeviceFingerprint() : null;
    const ip = options.sameDevice ? randomIp() : null;
    const sessionId = newSessionId('drain');

    const totalSpanMs = options.withdrawalCount * options.intervalMinutes * 60_000;

    emit({
      type: 'milestone',
      message:
        `Draining NGN ${(options.amountKobo / 100).toLocaleString()} at a time, ` +
        `every ${humaniseMs(options.intervalMinutes * 60_000)}, ` +
        `over a simulated ${humaniseMs(totalSpanMs)}`,
      timestamp: Date.now(),
    });

    emit({
      type: 'milestone',
      message:
        'Timestamps are simulated. If the target derives its velocity windows from ' +
        'server arrival time rather than the event timestamp, this run measures a burst, not a slow drain.',
      timestamp: Date.now(),
    });

    for (let i = 0; i < options.withdrawalCount; i++) {
      if (signal.aborted) break;
      if (results.attempts >= options.maxTotalAttempts) break;

      const jitter = options.amountJitterKobo
        ? randomInt(-options.amountJitterKobo, options.amountJitterKobo)
        : 0;
      const amount = Math.max(1, options.amountKobo + jitter);

      const overrides = { timestamp: clock.iso(), session_id: sessionId };
      if (device) overrides.device_fingerprint = device;
      if (ip) overrides.ip_address = ip;

      const response = await scoreAndCount({
        ctx,
        method: 'scoreWithdrawal',
        payload: buildWithdrawalPayload(options.targetUserId, { amount }, overrides),
        results,
        stage: 'withdrawal',
      });

      results.withdrawalsAttempted++;

      if (response?.decision === 'ALLOW') {
        results.drainedKobo += amount;
      } else if (response?.decision === 'BLOCK' && results.firstBlockedAtWithdrawal == null) {
        results.firstBlockedAtWithdrawal = i + 1;
        emit({
          type: 'milestone',
          message:
            `Blocked at withdrawal ${i + 1} of ${options.withdrawalCount} — ` +
            `NGN ${(results.drainedKobo / 100).toLocaleString()} already gone ` +
            `over ${humaniseMs(clock.elapsedMs())}`,
          timestamp: Date.now(),
        });
      } else if (response?.decision === 'STEP_UP' && results.firstStepUpAtWithdrawal == null) {
        results.firstStepUpAtWithdrawal = i + 1;
      }

      clock.advance();

      try {
        await sleep(options.delayMs, signal);
      } catch {
        break;
      }
    }

    if (results.firstBlockedAtWithdrawal == null) {
      emit({
        type: 'milestone',
        message:
          `Never blocked. NGN ${(results.drainedKobo / 100).toLocaleString()} drained across ` +
          `${results.withdrawalsAttempted} withdrawals — short-window velocity alone does not catch this.`,
        timestamp: Date.now(),
      });
    }

    return {
      ...results,
      estimatedLossKobo: results.drainedKobo,
      attackerSucceeded: results.firstBlockedAtWithdrawal == null && results.drainedKobo > 0,
      simulatedTime: true,
      simulatedSpan: humaniseMs(clock.elapsedMs()),
      // How much got out before anything fired — the number that matters here.
      drainedBeforeFirstBlockKobo: results.drainedKobo,
    };
  },
};
