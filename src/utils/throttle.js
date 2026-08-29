/**
 * Outbound request rate limiting.
 *
 * `fraud-sim` generates attack traffic, so the difference between a useful
 * simulation and a denial-of-service against your own staging environment is
 * one mistyped `delayMs`. Per-scenario pacing is a convention; this is the
 * guard rail that holds when the convention is ignored.
 *
 * The limiter wraps the *target adapter* rather than living inside scenarios,
 * so every call from every scenario passes through it — including scenarios
 * written by users, which cannot be expected to police themselves.
 *
 * It is a sliding window, not a fixed one: a run cannot spend its whole budget
 * in the first 50ms of each second and call the average acceptable.
 */

const SCORING_METHODS = ['scoreLogin', 'scoreWithdrawal', 'scoreAction', 'reportEvent'];

/**
 * Wrap a target adapter so its outbound calls never exceed `maxPerSecond`.
 *
 * Passing `Infinity` (or a non-finite value) returns the target untouched —
 * useful in tests, and for users who have their own pacing and mean it.
 *
 * @param {object} target - Any TargetAdapter.
 * @param {number} maxPerSecond
 * @param {{ onThrottle?: (waitMs: number) => void, signal?: AbortSignal }} [hooks]
 * @returns {object} A adapter with the same shape as `target`.
 */
export function throttleTarget(target, maxPerSecond, hooks = {}) {
  if (!Number.isFinite(maxPerSecond)) return target;
  if (maxPerSecond <= 0) {
    throw new Error(`maxRequestsPerSecond must be greater than 0, received: ${maxPerSecond}`);
  }

  const limiter = rateLimiter(maxPerSecond, hooks);
  const wrapped = Object.create(Object.getPrototypeOf(target) ?? Object.prototype);

  // Copy anything the adapter exposes that we are not wrapping — test helpers
  // like mockAdapter's `_calls` have to survive the wrapping.
  for (const key of allKeys(target)) {
    const value = target[key];
    wrapped[key] = typeof value === 'function' ? value.bind(target) : value;
  }

  for (const method of SCORING_METHODS) {
    if (typeof target[method] !== 'function') continue;
    wrapped[method] = async (...args) => {
      await limiter();
      return target[method](...args);
    };
  }

  return wrapped;
}

/**
 * A sliding-window limiter. Resolves immediately while under the limit;
 * otherwise waits until the oldest request in the window ages out.
 */
export function rateLimiter(maxPerSecond, hooks = {}) {
  const windowMs = 1000;
  /** @type {number[]} timestamps of recent requests, oldest first */
  const recent = [];

  return async function acquire() {
    for (;;) {
      const now = Date.now();

      // Drop anything that has aged out of the window.
      while (recent.length > 0 && now - recent[0] >= windowMs) recent.shift();

      if (recent.length < maxPerSecond) {
        recent.push(now);
        return;
      }

      const waitMs = windowMs - (now - recent[0]);
      hooks.onThrottle?.(waitMs);
      await delay(waitMs, hooks.signal);
    }
  };
}

function delay(ms, signal) {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms);
    function finish() {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', finish);
      resolve();
    }
    // An aborted run should stop waiting on a rate limit immediately; the
    // scenario's own abort check is what ends the loop.
    signal?.addEventListener?.('abort', finish, { once: true });
  });
}

/** Own and inherited enumerable keys, so adapters built either way survive. */
function allKeys(target) {
  const keys = new Set();
  for (let obj = target; obj && obj !== Object.prototype; obj = Object.getPrototypeOf(obj)) {
    for (const key of Object.getOwnPropertyNames(obj)) {
      if (key !== 'constructor') keys.add(key);
    }
  }
  return keys;
}
