/**
 * fraud-sim — public API surface
 *
 * Realistic synthetic attack traffic for testing fintech fraud detection systems.
 *
 * Usage:
 *   import { run, runSuite, listScenarios, registerScenario } from 'fraud-sim';
 *   import { httpAdapter } from 'fraud-sim/adapters';
 *
 *   const report = await run('credential-stuffing', { target, options: {...} });
 */

/**
 * @typedef {import('./types.js').Scenario} Scenario
 * @typedef {import('./types.js').ScenarioMetadata} ScenarioMetadata
 * @typedef {import('./types.js').ScenarioReport} ScenarioReport
 * @typedef {import('./types.js').SuiteReport} SuiteReport
 * @typedef {import('./types.js').TargetAdapter} TargetAdapter
 */

import { Runner, DEFAULT_MAX_REQUESTS_PER_SECOND } from './runner.js';
import { scenarios as builtInScenarios } from './scenarios/index.js';
import { rateLimiter } from './utils/throttle.js';

/**
 * The fixed attacker IP pool, with declared geolocation and reputation.
 *
 * Re-exported here so a system under test can pre-warm its IP-intelligence
 * cache before a run. Most fraud engines resolve IP intel asynchronously and
 * fall back to neutral values on a cache miss — in a short simulation every IP
 * is new, so proxy, abuse-score, and geo rules never fire and the run
 * understates what the defence catches. Seeding from this pool removes that
 * blind spot, along with any dependency on a third-party lookup during a run.
 *
 * Used by scenarios when `options.ipPersona` is anything other than 'random'.
 */
export { DEMO_IP_POOL, demoIpPool, pickDemoIp } from './utils/random.js';
export { LOCALES, localeIds, resolveLocale, DEFAULT_LOCALE } from './locales/index.js';

// Module-level registry — extensible via registerScenario()
const registry = new Map();
for (const scenario of builtInScenarios) {
  registry.set(scenario.id, scenario);
}

/**
 * Run a single scenario against a target.
 *
 * @param {string} scenarioId - The ID of a registered scenario
 * @param {object} config
 * @param {TargetAdapter} config.target - A TargetAdapter
 * @param {object} [config.options] - Scenario-specific options (merged with defaults)
 * @param {function} [config.onEvent] - Event callback (event) => void
 * @param {AbortSignal} [config.signal] - For cancellation
 * @param {number} [config.seed] - Seed the run's randomness so it replays
 *   identically. Controls every generated value (IPs, devices, amounts,
 *   ordering) but not wall-clock timestamps.
 * @param {number} [config.maxRequestsPerSecond=25] - Ceiling on outbound
 *   requests. `Infinity` disables it.
 * @returns {Promise<ScenarioReport>}
 */
export async function run(scenarioId, config = {}) {
  const scenario = registry.get(scenarioId);
  if (!scenario) {
    const available = [...registry.keys()].join(', ');
    throw new Error(`Unknown scenario: "${scenarioId}". Available: ${available}`);
  }

  if (!config.target) {
    throw new Error('A target adapter is required. Use httpAdapter() or mockAdapter().');
  }

  const runner = new Runner();
  return runner.run(scenario, config);
}

/**
 * Run a suite of scenarios as a benchmark.
 *
 * @param {object} config
 * @param {string} config.name - Human-readable suite name
 * @param {Array<{id: string, options?: object}>} config.scenarios
 * @param {TargetAdapter} config.target
 * @param {function} [config.onEvent]
 * @param {AbortSignal} [config.signal]
 * @param {number} [config.seed] - Seeds the suite. Each scenario gets a
 *   distinct derived seed, so the suite replays as a whole without every
 *   scenario drawing the same values.
 * @param {number} [config.maxRequestsPerSecond=25] - Shared across the whole
 *   suite, including when scenarios run concurrently.
 * @param {number} [config.concurrency=1] - How many scenarios run at once.
 *   See the note below before raising it.
 * @returns {Promise<SuiteReport>}
 */
export async function runSuite(config = {}) {
  if (!config.scenarios || config.scenarios.length === 0) {
    throw new Error('A suite requires at least one scenario.');
  }

  const concurrency = config.concurrency ?? 1;
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error(`concurrency must be a positive integer, received: ${config.concurrency}`);
  }

  const startedAt = new Date().toISOString();
  const maxRequestsPerSecond =
    config.maxRequestsPerSecond ?? DEFAULT_MAX_REQUESTS_PER_SECOND;

  // One limiter for the whole suite. A limiter per run would let the effective
  // request ceiling scale with the concurrency — the opposite of a ceiling.
  const limiter = Number.isFinite(maxRequestsPerSecond)
    ? rateLimiter(maxRequestsPerSecond, { signal: config.signal })
    : null;

  const runOne = (entry, index) =>
    run(entry.id, {
      target: config.target,
      options: entry.options ?? {},
      onEvent: config.onEvent,
      signal: config.signal,
      llm: entry.llm ?? config.llm,
      ...(config.seed != null ? { seed: config.seed + index } : {}),
      ...(config.locale != null ? { locale: config.locale } : {}),
      maxRequestsPerSecond,
      ...(limiter ? { limiter } : {}),
    });

  const scenarioReports =
    concurrency === 1
      ? await runSequentially(config.scenarios, runOne)
      : await runPooled(config.scenarios, runOne, concurrency);

  return {
    suiteName: config.name ?? 'unnamed-suite',
    startedAt,
    completedAt: new Date().toISOString(),
    concurrency,
    scenarioReports,
    aggregate: aggregateReports(scenarioReports),
  };
}

async function runSequentially(entries, runOne) {
  const out = [];
  for (const [index, entry] of entries.entries()) {
    out.push(await runOne(entry, index));
  }
  return out;
}

/**
 * Run up to `limit` scenarios at once, preserving input order in the results.
 *
 * ── Before raising concurrency ────────────────────────────────────────
 * Scenarios sharing a target interleave their traffic, and most fraud engines
 * keep per-user and per-IP state. Two scenarios touching the same account at
 * once will influence each other's decisions, so a parallel suite measures a
 * *combined* attack rather than each attack independently. That is realistic —
 * real systems face concurrent attackers — but it is a different question from
 * "does this scenario get caught", and results will not match a sequential run.
 * Use distinct users per scenario if you want both speed and isolation.
 */
async function runPooled(entries, runOne, limit) {
  const results = new Array(entries.length);
  let cursor = 0;

  const workers = Array.from({ length: Math.min(limit, entries.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= entries.length) return;
      results[index] = await runOne(entries[index], index);
    }
  });

  await Promise.all(workers);
  return results;
}

/**
 * Returns metadata for all registered scenarios.
 * @returns {Array<ScenarioMetadata>}
 */
export function listScenarios() {
  return [...registry.values()].map((s) => ({
    id: s.id,
    name: s.name,
    description: s.description,
    defaultOptions: s.defaultOptions,
  }));
}

/**
 * Register a custom scenario. Useful for users extending the library
 * or for testing internal scenarios in isolation.
 *
 * @param {Scenario} scenario
 */
export function registerScenario(scenario) {
  validateScenario(scenario);
  registry.set(scenario.id, scenario);
}

/**
 * Remove a scenario from the registry. Primarily for testing.
 * @param {string} scenarioId
 */
export function unregisterScenario(scenarioId) {
  registry.delete(scenarioId);
}

// ── internals ───────────────────────────────────────────────────────────

function validateScenario(scenario) {
  if (!scenario || typeof scenario !== 'object') {
    throw new Error('Scenario must be an object.');
  }
  for (const field of ['id', 'name', 'description', 'run']) {
    if (!scenario[field]) {
      throw new Error(`Scenario is missing required field: "${field}".`);
    }
  }
  if (typeof scenario.run !== 'function') {
    throw new Error('Scenario.run must be a function.');
  }
  if (scenario.defaultOptions && typeof scenario.defaultOptions !== 'object') {
    throw new Error('Scenario.defaultOptions must be an object.');
  }
}

function aggregateReports(reports) {
  const totals = {
    attempts: 0,
    blocked: 0,
    stepUp: 0,
    allowed: 0,
    errors: 0,
  };
  for (const r of reports) {
    totals.attempts += r.attempts ?? 0;
    totals.blocked += r.blocked ?? 0;
    totals.stepUp += r.stepUp ?? 0;
    totals.allowed += r.allowed ?? 0;
    totals.errors += r.errors ?? 0;
  }

  // Same rule as a single run: attempts that never received a decision are not
  // evidence about the defence, so they are excluded from the rates rather than
  // being credited to it. See Runner.run.
  const scoredAttempts = Math.max(0, totals.attempts - totals.errors);

  return {
    ...totals,
    scoredAttempts,
    blockRate: scoredAttempts > 0 ? totals.blocked / scoredAttempts : 0,
    stepUpRate: scoredAttempts > 0 ? totals.stepUp / scoredAttempts : 0,
    errorRate: totals.attempts > 0 ? totals.errors / totals.attempts : 0,
  };
}
