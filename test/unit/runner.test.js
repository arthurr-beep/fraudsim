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
    options: { b: 99, c: 3 },
  });

  assert.deepEqual(captured, { a: 1, b: 99, c: 3 });
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
