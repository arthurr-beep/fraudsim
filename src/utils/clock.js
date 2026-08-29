/**
 * Simulated clock.
 *
 * Some attacks are defined by their *timing* rather than their volume. A slow
 * drain spreads withdrawals over days; a velocity-evading attacker paces
 * attempts just under a rolling limit. Reproducing those in wall-clock time
 * would make a single run take days, so instead we advance the `timestamp`
 * field the target receives while sleeping only briefly — or not at all.
 *
 * This is honest as long as the target derives its windows from the event
 * timestamp. A system that stamps arrival time server-side will see the whole
 * run compressed into seconds and will (correctly) treat it as a burst. When
 * that happens the scenario is measuring the wrong thing, so scenarios using a
 * simulated clock say so in their report via `simulatedTime: true` and emit a
 * milestone explaining it.
 *
 * @example
 *   const clock = simulatedClock({ stepMs: 90 * 60 * 1000 }); // 90 minutes
 *   payload.timestamp = clock.iso();
 *   clock.advance();
 */

/**
 * @param {object} [config]
 * @param {number} [config.start] - Epoch ms to start from. Defaults to now.
 * @param {number} [config.stepMs] - Default advance applied by `advance()`.
 * @returns {{iso: () => string, epoch: () => number, advance: (ms?: number) => void,
 *   elapsedMs: () => number}}
 */
export function simulatedClock(config = {}) {
  const start = config.start ?? Date.now();
  const stepMs = config.stepMs ?? 0;

  if (!Number.isFinite(start)) {
    throw new Error('simulatedClock: start must be a finite epoch in milliseconds');
  }
  if (!Number.isFinite(stepMs) || stepMs < 0) {
    throw new Error('simulatedClock: stepMs must be a non-negative number');
  }

  let now = start;

  return {
    /** Current simulated time as an ISO-8601 string, for payload timestamps. */
    iso() {
      return new Date(now).toISOString();
    },

    /** Current simulated time in epoch milliseconds. */
    epoch() {
      return now;
    },

    /** Move the clock forward. Defaults to the configured step. */
    advance(ms) {
      const delta = ms ?? stepMs;
      if (!Number.isFinite(delta) || delta < 0) {
        throw new Error('simulatedClock.advance: expected a non-negative number of milliseconds');
      }
      now += delta;
    },

    /** How much simulated time has passed since the start. */
    elapsedMs() {
      return now - start;
    },
  };
}

/** Format a millisecond span as a short human string, for milestone messages. */
export function humaniseMs(ms) {
  const minutes = ms / 60000;
  if (minutes < 60) return `${Math.round(minutes)} min`;
  const hours = minutes / 60;
  if (hours < 48) return `${hours.toFixed(1)} hours`;
  return `${(hours / 24).toFixed(1)} days`;
}
