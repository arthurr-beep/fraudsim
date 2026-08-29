/**
 * Scenario: mule-network
 *
 * Stolen funds are rarely withdrawn in one move. They are layered: a source
 * account pushes money to a set of intermediary "mule" accounts, each of which
 * forwards nearly all of it onward to a common destination, keeping a small cut
 * as payment. The mules are often real people with real, previously clean
 * accounts — which is exactly why per-account rules struggle here.
 *
 * No individual transfer in this scenario need look unusual. What gives it away
 * is the graph: a fan-out followed by a fan-in, with high pass-through and low
 * retention at every intermediate hop.
 *
 * Defensive systems should catch this via:
 *   - Graph clustering        (accounts linked by transaction flow)
 *   - Pass-through ratio      (money in ≈ money out, within hours)
 *   - Fan-in concentration    (many unrelated accounts, one destination)
 *   - Dormancy-then-activity  (a quiet account suddenly moving funds)
 *
 * A system scoring transactions one at a time, with no memory of the graph,
 * will pass this scenario cleanly — which is the point of running it.
 */

import { sleep } from '../utils/sleep.js';
import {
  buildTransferPayload,
  newDeviceFingerprint,
} from '../utils/faker-helpers.js';
import { newResults, scoreAndCount } from '../utils/results.js';
import { simulatedClock, humaniseMs } from '../utils/clock.js';
import { randomAccountNumber, randomIp } from '../utils/random.js';

export default {
  id: 'mule-network',
  name: 'Mule network layering',
  description:
    'A source account fans funds out to intermediary mules, each of which forwards nearly all of it to one final destination.',

  defaultOptions: {
    sourceUserId: null, // required — the compromised or complicit origin
    muleCount: 8,
    amountPerMuleKobo: 30000000, // NGN 300,000 to each mule
    retentionRatio: 0.05, // the cut each mule keeps; the rest is forwarded
    finalDestinationAccount: null, // null → generated
    forwardDelayMinutes: 45, // simulated gap between receiving and forwarding
    delayMs: 100, // wall-clock pacing, unrelated to the simulated gap
    maxTotalAttempts: 100,
  },

  async run(ctx) {
    const { options, emit, signal } = ctx;

    if (!options.sourceUserId) {
      throw new Error('mule-network requires options.sourceUserId');
    }
    if (options.muleCount < 1) {
      throw new Error('mule-network requires options.muleCount >= 1');
    }
    if (options.retentionRatio < 0 || options.retentionRatio >= 1) {
      throw new Error('mule-network requires 0 <= options.retentionRatio < 1');
    }

    const results = newResults({
      fanOutTransfers: 0,
      forwardTransfers: 0,
      fanOutAllowed: 0,
      forwardAllowed: 0,
      totalMovedKobo: 0,
      reachedDestinationKobo: 0,
    });

    const destination = options.finalDestinationAccount ?? randomAccountNumber();
    const clock = simulatedClock({ start: Date.now() });

    // Each mule is a distinct account, device and network — they are separate
    // people. That is what makes the graph, not the endpoints, the signal.
    const mules = Array.from({ length: options.muleCount }, (_, i) => ({
      userId: `mule_${String(i + 1).padStart(2, '0')}`,
      account: randomAccountNumber(),
      device: newDeviceFingerprint(),
      ip: randomIp(),
    }));

    emit({
      type: 'milestone',
      message:
        `Layering NGN ${((options.amountPerMuleKobo * mules.length) / 100).toLocaleString()} ` +
        `through ${mules.length} mules to ${destination}, ` +
        `each keeping ${(options.retentionRatio * 100).toFixed(0)}%`,
      timestamp: Date.now(),
    });

    // ── Stage 1: fan out from the source to every mule ──────────────────
    for (const mule of mules) {
      if (signal.aborted) break;
      if (results.attempts >= options.maxTotalAttempts) break;

      const response = await scoreAndCount({
        ctx,
        method: 'scoreWithdrawal',
        payload: buildTransferPayload(
          options.sourceUserId,
          mule.account,
          options.amountPerMuleKobo,
          { timestamp: clock.iso() }
        ),
        results,
        stage: 'fan-out',
      });

      results.fanOutTransfers++;
      if (response?.decision === 'ALLOW') {
        results.fanOutAllowed++;
        results.totalMovedKobo += options.amountPerMuleKobo;
        mule.funded = true;
      }

      clock.advance(60_000); // a minute between outbound transfers

      try {
        await sleep(options.delayMs, signal);
      } catch {
        break;
      }
    }

    if (results.fanOutAllowed === 0) {
      emit({
        type: 'milestone',
        message: 'Every outbound transfer was stopped — the network never funded',
        timestamp: Date.now(),
      });
      return finalise(results, destination, mules, clock);
    }

    // ── Stage 2: each funded mule forwards its cut onward ───────────────
    clock.advance(options.forwardDelayMinutes * 60_000);

    emit({
      type: 'milestone',
      message:
        `${results.fanOutAllowed} mules funded — forwarding onward after ` +
        `${humaniseMs(options.forwardDelayMinutes * 60_000)}`,
      timestamp: Date.now(),
    });

    const forwardKobo = Math.round(options.amountPerMuleKobo * (1 - options.retentionRatio));

    for (const mule of mules) {
      if (signal.aborted) break;
      if (!mule.funded) continue;
      if (results.attempts >= options.maxTotalAttempts) break;

      const response = await scoreAndCount({
        ctx,
        method: 'scoreWithdrawal',
        payload: buildTransferPayload(mule.userId, destination, forwardKobo, {
          ip_address: mule.ip,
          device_fingerprint: mule.device,
          timestamp: clock.iso(),
        }),
        results,
        stage: 'forward',
      });

      results.forwardTransfers++;
      if (response?.decision === 'ALLOW') {
        results.forwardAllowed++;
        results.reachedDestinationKobo += forwardKobo;
      }

      clock.advance(5 * 60_000);

      try {
        await sleep(options.delayMs, signal);
      } catch {
        break;
      }
    }

    return finalise(results, destination, mules, clock);
  },
};

function finalise(results, destination, mules, clock) {
  const passThroughRatio =
    results.totalMovedKobo > 0 ? results.reachedDestinationKobo / results.totalMovedKobo : 0;

  return {
    ...results,
    finalDestinationAccount: destination,
    muleAccounts: mules.map((m) => m.account),
    // The ratio a graph-aware system should find alarming: money arriving and
    // leaving an intermediary almost untouched.
    passThroughRatio: Math.round(passThroughRatio * 1000) / 1000,
    estimatedLossKobo: results.reachedDestinationKobo,
    attackerSucceeded: results.reachedDestinationKobo > 0,
    simulatedTime: true,
    simulatedSpan: humaniseMs(clock.elapsedMs()),
  };
}
