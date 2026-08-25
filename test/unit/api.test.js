import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  run,
  runSuite,
  listScenarios,
  registerScenario,
  unregisterScenario,
} from '../../src/index.js';
import { mockAdapter } from '../../src/adapters/mock.js';

test('listScenarios returns at least the two v0.1 scenarios', () => {
  const scenarios = listScenarios();
  const ids = scenarios.map((s) => s.id);
  assert.ok(ids.includes('credential-stuffing'));
  assert.ok(ids.includes('account-drain'));
});

test('listScenarios returns metadata for each scenario', () => {
  const scenarios = listScenarios();
  for (const s of scenarios) {
    assert.ok(s.id, 'scenario has id');
    assert.ok(s.name, 'scenario has name');
    assert.ok(s.description, 'scenario has description');
    assert.ok(s.defaultOptions, 'scenario has defaultOptions');
  }
});

test('run rejects unknown scenarios with a helpful error', async () => {
  await assert.rejects(
    run('does-not-exist', { target: mockAdapter() }),
    /Unknown scenario.*Available/
  );
});

test('run requires a target adapter', async () => {
  await assert.rejects(run('credential-stuffing', {}), /target adapter is required/);
});

test('registerScenario adds a custom scenario to the registry', async () => {
  const customScenario = {
    id: 'test-custom-001',
    name: 'Custom',
    description: 'Test',
    defaultOptions: {},
    async run() {
      return { attempts: 1, blocked: 0, stepUp: 0, allowed: 1 };
    },
  };

  registerScenario(customScenario);

  const ids = listScenarios().map((s) => s.id);
  assert.ok(ids.includes('test-custom-001'));

  const report = await run('test-custom-001', { target: mockAdapter() });
  assert.equal(report.attempts, 1);

  unregisterScenario('test-custom-001');
  assert.ok(!listScenarios().some((s) => s.id === 'test-custom-001'));
});

test('registerScenario validates required fields', () => {
  assert.throws(() => registerScenario({}), /missing required field/);
  assert.throws(
    () => registerScenario({ id: 'x', name: 'x', description: 'x' }),
    /run/
  );
  assert.throws(
    () => registerScenario({ id: 'x', name: 'x', description: 'x', run: 'not-a-function' }),
    /must be a function/
  );
});

test('runSuite runs all scenarios and returns an aggregate report', async () => {
  registerScenario({
    id: 'test-suite-a',
    name: 'a',
    description: 'a',
    async run() {
      return { attempts: 10, blocked: 8, stepUp: 1, allowed: 1 };
    },
  });
  registerScenario({
    id: 'test-suite-b',
    name: 'b',
    description: 'b',
    async run() {
      return { attempts: 10, blocked: 2, stepUp: 3, allowed: 5 };
    },
  });

  const result = await runSuite({
    name: 'test-suite',
    scenarios: [{ id: 'test-suite-a' }, { id: 'test-suite-b' }],
    target: mockAdapter(),
  });

  assert.equal(result.scenarioReports.length, 2);
  assert.equal(result.aggregate.attempts, 20);
  assert.equal(result.aggregate.blocked, 10);
  assert.equal(result.aggregate.blockRate, 0.5);

  unregisterScenario('test-suite-a');
  unregisterScenario('test-suite-b');
});

test('runSuite requires at least one scenario', async () => {
  await assert.rejects(runSuite({ scenarios: [] }), /at least one scenario/);
});
