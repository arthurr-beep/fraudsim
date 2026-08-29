/**
 * Runner — orchestrates the lifecycle of a single scenario execution.
 *
 * Responsibilities:
 *   - Merge user options with scenario defaults
 *   - Provide the ScenarioContext (target, emit, signal)
 *   - Forward events to the user's onEvent callback
 *   - Wrap scenario errors with useful context
 *   - Emit a final 'summary' event when the scenario completes
 *
 *   - Install the run's random source when a seed is given
 *   - Enforce the outbound request rate limit
 *
 * Non-responsibilities:
 *   - The runner does NOT know about HTTP, LLMs, faker, or specific scenarios.
 *     Every concrete behaviour lives in a scenario or an adapter.
 */

import { withSeed } from './utils/random-source.js';
import { throttleTarget } from './utils/throttle.js';

/**
 * Ceiling on outbound requests per second, applied to every scenario unless
 * overridden. High enough that the shipped scenarios never touch it, low
 * enough that a `delayMs: 0` typo against a real host stays a simulation
 * rather than becoming a denial-of-service. Pass `Infinity` to disable.
 */
export const DEFAULT_MAX_REQUESTS_PER_SECOND = 25;

export class Runner {
  async run(scenario, config) {
    const startedAt = Date.now();

    assertKnownOptions(scenario, config.options);

    const options = {
      ...(scenario.defaultOptions ?? {}),
      ...(config.options ?? {}),
    };

    const onEvent = config.onEvent ?? (() => {});
    const signal = config.signal ?? new AbortController().signal;

    // Wrap onEvent so we never let a buggy subscriber crash the runner.
    const emit = (event) => {
      try {
        onEvent(event);
      } catch (err) {
        // Subscribers should not break simulations.
        // We log to stderr but continue.
        console.error('[fraud-sim] subscriber threw:', err);
      }
    };

    const maxRequestsPerSecond =
      config.maxRequestsPerSecond ?? DEFAULT_MAX_REQUESTS_PER_SECOND;

    let throttledMs = 0;
    const target = throttleTarget(config.target, maxRequestsPerSecond, {
      onThrottle: (waitMs) => {
        throttledMs += waitMs;
      },
      signal,
    });

    const context = {
      options,
      target,
      llm: config.llm, // optional, used only by adaptive scenarios (v0.2+)
      emit,
      signal,
    };

    if (config.seed != null) {
      emit({
        type: 'milestone',
        message: `Seeded run (seed ${config.seed}) — random choices will replay identically`,
        timestamp: Date.now(),
      });
    }

    let report;
    try {
      // A seeded run installs its generator for the whole scenario, across
      // every await inside it. Unseeded runs use the system source.
      report =
        config.seed != null
          ? await withSeed(config.seed, () => scenario.run(context))
          : await scenario.run(context);
    } catch (err) {
      emit({
        type: 'error',
        message: `Scenario "${scenario.id}" failed: ${err.message}`,
        details: { stack: err.stack },
        timestamp: Date.now(),
      });
      throw err;
    }

    // Normalise the report. Scenarios may return loose shapes; the runner
    // ensures the canonical fields exist so downstream tooling is reliable.
    //
    // Derived rates are computed *after* merging the scenario's own fields, so
    // a scenario cannot accidentally shadow them with a stale value.
    const merged = {
      scenarioId: scenario.id,
      scenarioName: scenario.name,
      startedAt,
      completedAt: Date.now(),
      durationMs: Date.now() - startedAt,
      // Present only when seeded, so a report never implies reproducibility
      // it does not have.
      ...(config.seed != null ? { seed: config.seed } : {}),
      ...report, // scenarios can add custom fields
    };

    const attempts = merged.attempts ?? 0;
    const blocked = merged.blocked ?? 0;
    const stepUp = merged.stepUp ?? 0;
    const allowed = merged.allowed ?? 0;
    const errors = merged.errors ?? 0;

    // Attempts that actually came back with a decision. An attempt that failed
    // on rate limiting, a timeout, or a 5xx is not evidence about the defence
    // either way, so it is excluded from the rates rather than being counted as
    // a block (which would make a target look better the more it fell over) or
    // as an allow (which would make it look worse).
    const scoredAttempts = Math.max(0, attempts - errors);

    const normalised = {
      ...merged,
      attempts,
      blocked,
      stepUp,
      allowed,
      errors,
      scoredAttempts,
      blockRate: scoredAttempts > 0 ? blocked / scoredAttempts : 0,
      stepUpRate: scoredAttempts > 0 ? stepUp / scoredAttempts : 0,
      errorRate: attempts > 0 ? errors / attempts : 0,
    };

    if (throttledMs > 0) {
      emit({
        type: 'warning',
        message:
          `Rate limit held this run back by ${(throttledMs / 1000).toFixed(1)}s ` +
          `(cap: ${maxRequestsPerSecond}/s). The scenario asked to go faster than the ` +
          'configured ceiling — raise maxRequestsPerSecond deliberately if that is what you want.',
        throttledMs,
        maxRequestsPerSecond,
        timestamp: Date.now(),
      });
    }

    if (errors > 0) {
      emit({
        type: 'warning',
        message:
          `${errors} of ${attempts} attempts failed before being scored ` +
          `(${(normalised.errorRate * 100).toFixed(1)}%). Rates below are over the ` +
          `${scoredAttempts} attempts that were actually scored. Check errorRate ` +
          'before treating this run as a measurement of the defence.',
        errors,
        attempts,
        errorRate: normalised.errorRate,
        timestamp: Date.now(),
      });
    }

    emit({
      type: 'summary',
      report: normalised,
      timestamp: Date.now(),
    });

    return normalised;
  }
}

/**
 * Reject option keys the scenario does not declare.
 *
 * Every scenario's surface is its `defaultOptions`. Without this check a typo
 * — `attemptsPerIP` for `attemptsPerIp` — silently falls back to the default,
 * and the run completes and reports a number that answers a different question
 * than the one asked. Failing loudly is the only safe behaviour for a tool
 * whose output is a measurement.
 *
 * Scenarios that declare no `defaultOptions` (custom ones registered via
 * `registerScenario`) are skipped — there is nothing to validate against.
 */
function assertKnownOptions(scenario, userOptions) {
  if (!userOptions || !scenario.defaultOptions) return;

  const known = Object.keys(scenario.defaultOptions);
  const unknown = Object.keys(userOptions).filter((key) => !(key in scenario.defaultOptions));
  if (unknown.length === 0) return;

  const details = unknown.map((key) => {
    const suggestion = closestMatch(key, known);
    return suggestion ? `"${key}" (did you mean "${suggestion}"?)` : `"${key}"`;
  });

  throw new Error(
    `Unknown option${unknown.length > 1 ? 's' : ''} for scenario "${scenario.id}": ` +
      `${details.join(', ')}. Valid options: ${known.sort().join(', ')}.`
  );
}

/** Nearest known key within a small edit distance, or null. */
function closestMatch(input, candidates) {
  const lower = input.toLowerCase();

  // Case-only mistakes are the most common, so check those first.
  const caseMatch = candidates.find((c) => c.toLowerCase() === lower);
  if (caseMatch) return caseMatch;

  let best = null;
  let bestDistance = Infinity;
  for (const candidate of candidates) {
    const distance = editDistance(lower, candidate.toLowerCase());
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }

  // Beyond a couple of edits a "did you mean" is noise rather than help.
  const threshold = Math.min(3, Math.floor(input.length / 2));
  return bestDistance <= threshold ? best : null;
}

/** Levenshtein distance, iterative with a single row. */
function editDistance(a, b) {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);

  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + cost);
    }
    previous = current;
  }

  return previous[b.length];
}
