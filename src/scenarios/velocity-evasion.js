/**
 * Scenario: velocity-evasion
 *
 * An attacker who has already probed the target and learned roughly where its
 * rate limits sit, and now paces attempts to stay just underneath them. Not a
 * botnet — one attacker, being deliberately patient.
 *
 * This is a direct test of a specific weakness: a counter with a fixed
 * threshold is a line, and any line can be stayed under. The scenario
 * parameterises the attacker's *belief* about the limit and derives its pacing
 * from that, so you can also run it with a deliberately wrong belief to see how
 * much margin your thresholds actually have.
 *
 * Defensive systems should catch this via:
 *   - Adaptive thresholds keyed to the user's own baseline
 *   - Multi-window counters (staying under an hourly limit still breaks a daily one)
 *   - Statistical anomaly detection on inter-arrival times — perfectly spaced
 *     attempts are themselves unnatural
 *   - Device and network novelty, which pacing does nothing to hide
 *
 * ── On simulated time ─────────────────────────────────────────────────
 * Evasion is defined by spacing, so this scenario advances the `timestamp`
 * field rather than sleeping for hours. That is faithful only if the target
 * derives its windows from the event timestamp; a system stamping server-side
 * arrival time will see a burst and block it, which tells you nothing about
 * evasion. `simulatedTime: true` is set on the report.
 */

import { sleep } from '../utils/sleep.js';
import {
  buildLoginPayload,
  newDeviceFingerprint,
} from '../utils/faker-helpers.js';
import { newResults, scoreAndCount } from '../utils/results.js';
import { simulatedClock, humaniseMs } from '../utils/clock.js';
import { randomIp, randomInt, pickDemoIp } from '../utils/random.js';

export default {
  id: 'velocity-evasion',
  name: 'Velocity evasion',
  description:
    'An attacker who has learned where the rate limits sit and paces attempts to stay just under them.',

  defaultOptions: {
    targetUserId: null, // required
    attemptCount: 24,
    assumedLimit: 5, // attempts the attacker believes are allowed...
    assumedWindowSeconds: 600, // ...within this window
    safetyMargin: 1.25, // how far under the limit they stay (1.0 = exactly at it)
    jitterRatio: 0.15, // randomise spacing — perfect regularity is its own signal
    rotateDevice: true, // pacing hides volume, not novelty
    ipPersona: 'random',
    delayMs: 50, // wall-clock pacing only
    maxTotalAttempts: 200,
  },

  async run(ctx) {
    const { options, emit, signal } = ctx;

    if (!options.targetUserId) {
      throw new Error('velocity-evasion requires options.targetUserId');
    }
    if (options.assumedLimit < 1) {
      throw new Error('velocity-evasion requires options.assumedLimit >= 1');
    }
    if (options.safetyMargin <= 0) {
      throw new Error('velocity-evasion requires options.safetyMargin > 0');
    }

    // To stay under `limit` attempts per `window`, space them at least
    // window/limit apart, times a margin the attacker keeps for safety.
    const baseSpacingMs =
      ((options.assumedWindowSeconds * 1000) / options.assumedLimit) * options.safetyMargin;

    const results = newResults({
      attemptsMade: 0,
      firstNonAllowAtAttempt: null,
      evaded: false,
    });

    const clock = simulatedClock({ start: Date.now() });
    const fixedDevice = options.rotateDevice ? null : newDeviceFingerprint();
    const fixedIp = options.ipPersona === 'random' ? randomIp() : null;

    const effectiveRate = (options.assumedWindowSeconds * 1000) / baseSpacingMs;

    emit({
      type: 'milestone',
      message:
        `Pacing at one attempt every ${humaniseMs(baseSpacingMs)} — ` +
        `${effectiveRate.toFixed(1)} per ${options.assumedWindowSeconds}s window, ` +
        `against an assumed limit of ${options.assumedLimit}`,
      timestamp: Date.now(),
    });

    emit({
      type: 'milestone',
      message:
        'Timestamps are simulated. If the target uses server arrival time for its windows, ' +
        'this run measures a burst rather than an evasion attempt.',
      timestamp: Date.now(),
    });

    for (let i = 0; i < options.attemptCount; i++) {
      if (signal.aborted) break;
      if (results.attempts >= options.maxTotalAttempts) break;

      const ip = fixedIp ?? pickIp(options.ipPersona);
      const overrides = {
        timestamp: clock.iso(),
        ip_address: typeof ip === 'string' ? ip : ip.ip,
      };
      if (fixedDevice) overrides.device_fingerprint = fixedDevice;

      const response = await scoreAndCount({
        ctx,
        method: 'scoreLogin',
        payload: buildLoginPayload(options.targetUserId, overrides),
        results,
        stage: 'paced-attempt',
        ipIntel: typeof ip === 'string' ? undefined : ip.intel,
      });

      results.attemptsMade++;

      if (response && response.decision !== 'ALLOW' && results.firstNonAllowAtAttempt == null) {
        results.firstNonAllowAtAttempt = i + 1;
        emit({
          type: 'milestone',
          message:
            `Pushback at attempt ${i + 1} (${response.decision}) after ` +
            `${humaniseMs(clock.elapsedMs())} of simulated time — pacing did not save them`,
          timestamp: Date.now(),
        });
      }

      // Jitter the spacing. A perfectly regular interval is itself detectable.
      const jitter = options.jitterRatio
        ? randomInt(-baseSpacingMs * options.jitterRatio, baseSpacingMs * options.jitterRatio)
        : 0;
      clock.advance(Math.max(1, Math.round(baseSpacingMs + jitter)));

      try {
        await sleep(options.delayMs, signal);
      } catch {
        break;
      }
    }

    results.evaded = results.firstNonAllowAtAttempt == null && results.attemptsMade > 0;

    if (results.evaded) {
      emit({
        type: 'milestone',
        message:
          `All ${results.attemptsMade} attempts allowed across ${humaniseMs(clock.elapsedMs())}. ` +
          'Fixed-threshold counters can be paced under; a baseline-aware model is what catches this.',
        timestamp: Date.now(),
      });
    }

    return {
      ...results,
      attackerSucceeded: results.evaded,
      pacingMs: Math.round(baseSpacingMs),
      effectiveRatePerWindow: Math.round(effectiveRate * 100) / 100,
      assumedLimit: options.assumedLimit,
      simulatedTime: true,
      simulatedSpan: humaniseMs(clock.elapsedMs()),
    };
  },
};

function pickIp(persona) {
  if (!persona || persona === 'random') return { ip: randomIp(), intel: undefined };
  const resolved = persona === 'mixed' ? 'proxy' : persona;
  const { ip, ...intel } = pickDemoIp(resolved);
  return { ip, intel };
}
