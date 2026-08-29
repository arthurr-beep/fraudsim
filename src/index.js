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

import { Runner } from './runner.js';
import { scenarios as builtInScenarios } from './scenarios/index.js';

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
export { DEMO_IP_POOL, pickDemoIp } from './utils/random.js';

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
 * @param {object} config.target - A TargetAdapter
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
 * v0.1 — runs sequentially. v0.4 will add parallel execution and full reporting.
 *
 * @param {object} config
 * @param {string} config.name - Human-readable suite name
 * @param {Array<{id: string, options?: object}>} config.scenarios
 * @param {object} config.target
 * @param {function} [config.onEvent]
 * @returns {Promise<SuiteReport>}
 */
export async function runSuite(config = {}) {
  if (!config.scenarios || config.scenarios.length === 0) {
    throw new Error('A suite requires at least one scenario.');
  }

  const startedAt = new Date().toISOString();
  const scenarioReports = [];

  for (const entry of config.scenarios) {
    const report = await run(entry.id, {
      target: config.target,
      options: entry.options ?? {},
      onEvent: config.onEvent,
      signal: config.signal,
      llm: entry.llm ?? config.llm,
      // Each scenario gets a distinct but derived seed, so a suite is
      // reproducible as a whole without every scenario replaying the same
      // sequence of values.
      ...(config.seed != null ? { seed: config.seed + scenarioReports.length } : {}),
      ...(config.maxRequestsPerSecond != null
        ? { maxRequestsPerSecond: config.maxRequestsPerSecond }
        : {}),
    });
    scenarioReports.push(report);
  }

  return {
    suiteName: config.name ?? 'unnamed-suite',
    startedAt,
    completedAt: new Date().toISOString(),
    scenarioReports,
    aggregate: aggregateReports(scenarioReports),
  };
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
