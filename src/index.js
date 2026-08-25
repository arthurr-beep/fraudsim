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
  };
  for (const r of reports) {
    totals.attempts += r.attempts ?? 0;
    totals.blocked += r.blocked ?? 0;
    totals.stepUp += r.stepUp ?? 0;
    totals.allowed += r.allowed ?? 0;
  }
  return {
    ...totals,
    blockRate: totals.attempts > 0 ? totals.blocked / totals.attempts : 0,
    stepUpRate: totals.attempts > 0 ? totals.stepUp / totals.attempts : 0,
  };
}
