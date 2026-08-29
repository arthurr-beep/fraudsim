import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Runner } from '../../src/runner.js';
import { mockAdapter } from '../../src/adapters/mock.js';

test('Runner.run normalises the report shape', async () => {
  const runner = new Runner();
  const scenario = {
    id: 'test-scenario',
    name: 'Test',
    description: 'desc',
    defaultOptions: { foo: 1 },
    async run(_ctx) {
      return { attempts: 5, blocked: 3, stepUp: 1, allowed: 1 };
    },
  };

  const report = await runner.run(scenario, {
    target: mockAdapter(),
  });

  assert.equal(report.scenarioId, 'test-scenario');
  assert.equal(report.attempts, 5);
  assert.equal(report.blocked, 3);
  assert.equal(report.blockRate, 0.6);
  assert.ok(report.startedAt);
  assert.ok(report.completedAt);
  assert.ok(typeof report.durationMs === 'number');
});

test('Runner.run merges user options with scenario defaults', async () => {
  const runner = new Runner();
  let captured;
  const scenario = {
    id: 's',
    name: 'S',
    description: 'd',
    defaultOptions: { a: 1, b: 2 },
    async run(ctx) {
      captured = ctx.options;
      return { attempts: 0, blocked: 0, stepUp: 0, allowed: 0 };
    },
  };

  await runner.run(scenario, {
    target: mockAdapter(),
    options: { b: 99 },
  });

  assert.deepEqual(captured, { a: 1, b: 99 });
});

test('Runner.run rejects options the scenario does not declare', async () => {
  // A typo that silently falls back to the default produces a run that answers
  // a different question than the one asked, and looks perfectly healthy doing
  // it. For a tool whose output is a measurement, that has to fail loudly.
  const runner = new Runner();
  const scenario = {
    id: 's',
    name: 'S',
    description: 'd',
    defaultOptions: { attemptsPerIp: 3, delayMs: 10 },
    async run() {
      return { attempts: 0, blocked: 0, stepUp: 0, allowed: 0 };
    },
  };

  await assert.rejects(
    runner.run(scenario, { target: mockAdapter(), options: { attemptsPerIP: 9 } }),
    /Unknown option .*attemptsPerIP.*did you mean "attemptsPerIp"/s
  );

  await assert.rejects(
    runner.run(scenario, { target: mockAdapter(), options: { wibble: 1 } }),
    /Unknown option for scenario "s": "wibble"/
  );

  await assert.rejects(
    runner.run(scenario, { target: mockAdapter(), options: { wibble: 1, wobble: 2 } }),
    /Unknown options for scenario "s"/
  );
});

test('Runner.run skips option validation for scenarios with no declared options', async () => {
  const runner = new Runner();
  let captured;
  const scenario = {
    id: 'freeform',
    name: 'F',
    description: 'd',
    async run(ctx) {
      captured = ctx.options;
      return { attempts: 0, blocked: 0, stepUp: 0, allowed: 0 };
    },
  };

  await runner.run(scenario, { target: mockAdapter(), options: { anything: 1 } });
  assert.deepEqual(captured, { anything: 1 });
});

test('Runner.run keeps infrastructure errors out of the block rate', async () => {
  const runner = new Runner();
  const scenario = {
    id: 'e',
    name: 'E',
    description: 'd',
    defaultOptions: {},
    async run() {
      // 4 real blocks, 6 attempts that never got scored.
      return { attempts: 10, blocked: 4, stepUp: 0, allowed: 0, errors: 6 };
    },
  };

  const events = [];
  const report = await runner.run(scenario, {
    target: mockAdapter(),
    onEvent: (e) => events.push(e),
  });

  assert.equal(report.scoredAttempts, 4);
  assert.equal(report.blockRate, 1); // 4 of the 4 that were actually scored
  assert.equal(report.errorRate, 0.6);

  const warning = events.find((e) => e.type === 'warning');
  assert.ok(warning, 'a run that is two-thirds errors must warn');
  assert.equal(warning.errors, 6);
});

test('Runner.run reports clean runs unchanged', async () => {
  const runner = new Runner();
  const scenario = {
    id: 'c',
    name: 'C',
    description: 'd',
    defaultOptions: {},
    async run() {
      return { attempts: 10, blocked: 6, stepUp: 2, allowed: 2, errors: 0 };
    },
  };

  const events = [];
  const report = await runner.run(scenario, {
    target: mockAdapter(),
    onEvent: (e) => events.push(e),
  });

  assert.equal(report.scoredAttempts, 10);
  assert.equal(report.blockRate, 0.6);
  assert.equal(report.stepUpRate, 0.2);
  assert.equal(report.errorRate, 0);
  assert.equal(events.filter((e) => e.type === 'warning').length, 0);
});

test('Runner.run emits a summary event after the scenario completes', async () => {
  const events = [];
  const runner = new Runner();
  const scenario = {
    id: 's',
    name: 'S',
    description: 'd',
    async run(ctx) {
      ctx.emit({ type: 'attempt', round: 0, timestamp: Date.now() });
      return { attempts: 1, blocked: 0, stepUp: 0, allowed: 1 };
    },
  };

  await runner.run(scenario, {
    target: mockAdapter(),
    onEvent: (e) => events.push(e),
  });

  const lastEvent = events.at(-1);
  assert.equal(lastEvent.type, 'summary');
  assert.equal(lastEvent.report.attempts, 1);
});

test('Runner.run rethrows scenario errors but still emits an error event', async () => {
  const events = [];
  const runner = new Runner();
  const scenario = {
    id: 's',
    name: 'S',
    description: 'd',
    async run() {
      throw new Error('boom');
    },
  };

  await assert.rejects(
    runner.run(scenario, {
      target: mockAdapter(),
      onEvent: (e) => events.push(e),
    }),
    /boom/
  );

  const errorEvent = events.find((e) => e.type === 'error');
  assert.ok(errorEvent);
  assert.match(errorEvent.message, /boom/);
});

test('Runner.run isolates subscriber errors from scenario execution', async () => {
  const runner = new Runner();
  const scenario = {
    id: 's',
    name: 'S',
    description: 'd',
    async run(ctx) {
      ctx.emit({ type: 'attempt', round: 0, timestamp: Date.now() });
      return { attempts: 1, blocked: 0, stepUp: 0, allowed: 1 };
    },
  };

  // Subscriber that always throws — must not break the scenario
  const report = await runner.run(scenario, {
    target: mockAdapter(),
    onEvent: () => {
      throw new Error('subscriber crashed');
    },
  });

  assert.equal(report.attempts, 1);
});
