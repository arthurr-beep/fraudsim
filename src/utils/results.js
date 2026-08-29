/**
 * Shared decision tallying.
 *
 * Every scenario counts the same four outcomes and emits the same
 * attempt/response event pair around each call to the target. Centralising it
 * keeps the counts consistent and means a scenario file contains only the
 * attack logic.
 */

/** A fresh tally. */
export function newResults(extra = {}) {
  return { attempts: 0, blocked: 0, stepUp: 0, allowed: 0, errors: 0, ...extra };
}

/**
 * Record one decision against a tally. Anything that isn't a recognised
 * decision counts as an error rather than being silently dropped.
 */
export function countDecision(results, decision) {
  if (decision === 'BLOCK') results.blocked++;
  else if (decision === 'STEP_UP') results.stepUp++;
  else if (decision === 'ALLOW') results.allowed++;
  else results.errors++;
  return decision;
}

/**
 * Call one of the target's scoring methods, emitting the attempt/response
 * events and updating the tally.
 *
 * Returns the target's response, or `null` if the call threw — callers decide
 * whether a failed call ends the scenario or is skipped. A throw is counted as
 * an error but does NOT increment `attempts`, because nothing was scored.
 *
 * @param {object} args
 * @param {object} args.ctx      - The scenario context ({ target, emit }).
 * @param {string} args.method   - 'scoreLogin' | 'scoreWithdrawal' | 'scoreAction'
 * @param {object} args.payload  - The payload to send.
 * @param {object} args.results  - Tally from `newResults()`.
 * @param {string} [args.stage]  - Optional label carried on both events.
 * @param {object} [args.ipIntel] - Declared intel for the payload's IP, if known.
 * @returns {Promise<object|null>}
 */
export async function scoreAndCount({ ctx, method, payload, results, stage, ipIntel }) {
  const { target, emit } = ctx;

  if (typeof target?.[method] !== 'function') {
    throw new Error(
      `This scenario needs target.${method}(), which the adapter does not implement. ` +
        'httpAdapter supports it — map it to your endpoint via the `endpoints` option.'
    );
  }

  const round = results.attempts;
  const t0 = Date.now();
  emit({ type: 'attempt', round, payload, stage, ipIntel, timestamp: t0 });

  let response;
  try {
    response = await target[method](payload);
  } catch (err) {
    results.errors++;
    emit({
      type: 'error',
      message: `${stage ?? method} failed: ${err.message}`,
      round,
      timestamp: Date.now(),
    });
    return null;
  }

  emit({
    type: 'response',
    round,
    response,
    stage,
    latencyMs: Date.now() - t0,
    timestamp: Date.now(),
  });

  results.attempts++;
  countDecision(results, response?.decision ?? 'ERROR');
  return response;
}
