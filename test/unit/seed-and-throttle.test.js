import { test } from 'node:test';
import assert from 'node:assert/strict';

import { run, runSuite, registerScenario, unregisterScenario } from '../../src/index.js';
import { mockAdapter } from '../../src/adapters/mock.js';
import { withSeed, isSeeded, randomFloat } from '../../src/utils/random-source.js';
import { throttleTarget, rateLimiter } from '../../src/utils/throttle.js';
import { simulatedClock, humaniseMs } from '../../src/utils/clock.js';
import { newResults, countDecision, scoreAndCount } from '../../src/utils/results.js';
import { randomIp, randomInt } from '../../src/utils/random.js';

const FAST = { maxRequestsPerSecond: Infinity };
const allow = () => mockAdapter({ defaultResponse: { decision: 'ALLOW' } });

// ── seeding ─────────────────────────────────────────────────────────────

test('withSeed replays the same sequence for the same seed', () => {
  const draw = (seed) => withSeed(seed, () => [randomFloat(), randomInt(0, 1e6), randomIp()]);

  assert.deepEqual(draw(7), draw(7));
  assert.notDeepEqual(draw(7), draw(8));
});

test('withSeed scopes the generator and restores the default afterwards', () => {
  assert.equal(isSeeded(), false);
  withSeed(1, () => assert.equal(isSeeded(), true));
  assert.equal(isSeeded(), false);
});

test('withSeed survives await boundaries', async () => {
  const draw = (seed) =>
    withSeed(seed, async () => {
      const first = randomFloat();
      await new Promise((r) => setTimeout(r, 1));
      // If the source were a module global reset on await, this would differ.
      return [first, randomFloat()];
    });

  assert.deepEqual(await draw(3), await draw(3));
});

test('concurrent seeded runs do not contaminate each other', async () => {
  // The reason for AsyncLocalStorage rather than a module-level variable: two
  // runs interleaving must each keep their own generator.
  const solo = await withSeed(11, async () => {
    const out = [];
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setTimeout(r, 1));
      out.push(randomFloat());
    }
    return out;
  });

  const [a, b] = await Promise.all([
    withSeed(11, async () => {
      const out = [];
      for (let i = 0; i < 5; i++) {
        await new Promise((r) => setTimeout(r, 1));
        out.push(randomFloat());
      }
      return out;
    }),
    withSeed(99, async () => {
      const out = [];
      for (let i = 0; i < 5; i++) {
        await new Promise((r) => setTimeout(r, 1));
        out.push(randomFloat());
      }
      return out;
    }),
  ]);

  assert.deepEqual(a, solo, 'a concurrent run drifted from its solo result');
  assert.notDeepEqual(b, solo);
});

test('withSeed rejects a non-numeric seed instead of silently ignoring it', () => {
  assert.throws(() => withSeed('abc', () => 1), /seed must be a finite number/);
  assert.throws(() => withSeed(undefined, () => 1), /seed must be a finite number/);
});

test('a seeded run generates identical payloads', async () => {
  const options = { targetUserIds: ['a', 'b'], attackerCount: 3, attemptsPerIp: 3, delayMs: 0 };
  const fingerprint = async (seed) => {
    const target = allow();
    await run('credential-stuffing', { target, options, seed, ...FAST });
    return target._calls('scoreLogin').map((c) => `${c.ip_address}|${c.device_fingerprint}`);
  };

  assert.deepEqual(await fingerprint(42), await fingerprint(42));
  assert.notDeepEqual(await fingerprint(42), await fingerprint(43));
});

test('an unseeded run does not claim a seed in its report', async () => {
  const seeded = await run('credential-stuffing', {
    target: allow(),
    options: { targetUserIds: ['a'], attackerCount: 1, attemptsPerIp: 2, delayMs: 0 },
    seed: 5,
    ...FAST,
  });
  assert.equal(seeded.seed, 5);

  const unseeded = await run('credential-stuffing', {
    target: allow(),
    options: { targetUserIds: ['a'], attackerCount: 1, attemptsPerIp: 2, delayMs: 0 },
    ...FAST,
  });
  assert.ok(!('seed' in unseeded), 'a report must not imply reproducibility it does not have');
});

test('runSuite forwards the seed so a suite is reproducible as a whole', async () => {
  const scenarios = [
    { id: 'credential-stuffing', options: { targetUserIds: ['a'], attackerCount: 2, attemptsPerIp: 2, delayMs: 0 } },
    { id: 'slow-drain', options: { targetUserId: 'v', withdrawalCount: 3, delayMs: 0 } },
  ];

  const fingerprint = async (seed) => {
    const target = allow();
    await runSuite({ name: 's', target, scenarios, seed, ...FAST });
    return [
      ...target._calls('scoreLogin').map((c) => c.ip_address),
      ...target._calls('scoreWithdrawal').map((c) => c.transaction.amount),
    ];
  };

  assert.deepEqual(await fingerprint(100), await fingerprint(100));
  assert.notDeepEqual(await fingerprint(100), await fingerprint(200));
});

// ── rate limiting ───────────────────────────────────────────────────────

test('rateLimiter allows a burst up to the cap without waiting', async () => {
  const acquire = rateLimiter(10);
  const t0 = Date.now();
  for (let i = 0; i < 10; i++) await acquire();
  assert.ok(Date.now() - t0 < 100, 'should not sleep while under the cap');
});

test('rateLimiter holds the line once the window is full', async () => {
  const acquire = rateLimiter(5);
  const t0 = Date.now();
  for (let i = 0; i < 7; i++) await acquire();
  const elapsed = Date.now() - t0;
  assert.ok(elapsed >= 900, `expected a ~1s wait for the 6th request, waited ${elapsed}ms`);
});

test('throttleTarget caps outbound calls and preserves the adapter surface', async () => {
  const target = allow();
  const wrapped = throttleTarget(target, 5);

  const t0 = Date.now();
  for (let i = 0; i < 6; i++) await wrapped.scoreLogin({ user_id: 'u' });
  assert.ok(Date.now() - t0 >= 900);

  // Test helpers and any other adapter members must survive wrapping.
  assert.equal(typeof wrapped._calls, 'function');
  assert.equal(wrapped._calls('scoreLogin').length, 6);
});

test('throttleTarget returns the target untouched when disabled', () => {
  const target = allow();
  assert.equal(throttleTarget(target, Infinity), target);
});

test('throttleTarget rejects a nonsensical cap', () => {
  assert.throws(() => throttleTarget(allow(), 0), /greater than 0/);
  assert.throws(() => throttleTarget(allow(), -5), /greater than 0/);
});

test('a run warns when the rate cap actually held it back', async () => {
  const events = [];
  await run('credential-stuffing', {
    target: allow(),
    options: { targetUserIds: ['a'], attackerCount: 1, attemptsPerIp: 8, delayMs: 0, maxTotalAttempts: 8 },
    maxRequestsPerSecond: 5,
    onEvent: (e) => events.push(e),
  });

  const warning = events.find((e) => e.type === 'warning' && /Rate limit/.test(e.message));
  assert.ok(warning, 'a throttled run must say so — it changes how latency reads');
  assert.equal(warning.maxRequestsPerSecond, 5);
});

test('a run under the cap emits no rate-limit warning', async () => {
  const events = [];
  await run('credential-stuffing', {
    target: allow(),
    options: { targetUserIds: ['a'], attackerCount: 1, attemptsPerIp: 3, delayMs: 0 },
    onEvent: (e) => events.push(e),
  });

  assert.equal(events.filter((e) => /Rate limit/.test(e.message ?? '')).length, 0);
});

// ── clock ───────────────────────────────────────────────────────────────

test('simulatedClock advances by its configured step', () => {
  const clock = simulatedClock({ start: 0, stepMs: 60_000 });
  assert.equal(clock.epoch(), 0);
  clock.advance();
  assert.equal(clock.epoch(), 60_000);
  clock.advance(30_000);
  assert.equal(clock.epoch(), 90_000);
  assert.equal(clock.elapsedMs(), 90_000);
});

test('simulatedClock renders ISO timestamps for payloads', () => {
  const clock = simulatedClock({ start: Date.UTC(2026, 0, 1) });
  assert.equal(clock.iso(), '2026-01-01T00:00:00.000Z');
});

test('simulatedClock rejects invalid configuration and advances', () => {
  assert.throws(() => simulatedClock({ start: NaN }), /finite epoch/);
  assert.throws(() => simulatedClock({ stepMs: -1 }), /non-negative/);
  assert.throws(() => simulatedClock().advance(-5), /non-negative/);
});

test('humaniseMs picks a sensible unit', () => {
  assert.equal(humaniseMs(90_000), '2 min');
  assert.equal(humaniseMs(3 * 3600_000), '3.0 hours');
  assert.equal(humaniseMs(4 * 86_400_000), '4.0 days');
});

// ── results ─────────────────────────────────────────────────────────────

test('countDecision routes unrecognised decisions to errors', () => {
  const results = newResults();
  for (const d of ['BLOCK', 'STEP_UP', 'ALLOW', 'ERROR', undefined, 'WAT']) {
    countDecision(results, d);
  }
  assert.equal(results.blocked, 1);
  assert.equal(results.stepUp, 1);
  assert.equal(results.allowed, 1);
  assert.equal(results.errors, 3);
});

test('newResults carries scenario-specific fields alongside the tally', () => {
  const results = newResults({ cardsTested: 0 });
  assert.equal(results.attempts, 0);
  assert.equal(results.cardsTested, 0);
});

test('scoreAndCount names the missing method when an adapter is incomplete', async () => {
  const ctx = { target: { async scoreLogin() {} }, emit: () => {} };
  await assert.rejects(
    scoreAndCount({ ctx, method: 'scoreAction', payload: {}, results: newResults() }),
    /target\.scoreAction\(\), which the adapter does not implement/
  );
});

test('scoreAndCount counts a throwing target as an error, not an attempt', async () => {
  const events = [];
  const results = newResults();
  const ctx = {
    target: {
      async scoreLogin() {
        throw new Error('connection reset');
      },
    },
    emit: (e) => events.push(e),
  };

  const response = await scoreAndCount({ ctx, method: 'scoreLogin', payload: {}, results });

  assert.equal(response, null);
  assert.equal(results.errors, 1);
  assert.equal(results.attempts, 0, 'nothing was scored, so nothing was attempted');
  assert.ok(events.some((e) => e.type === 'error' && /connection reset/.test(e.message)));
});

test('scoreAndCount tags events with the stage it was given', async () => {
  const events = [];
  const results = newResults();
  const ctx = {
    target: { async scoreWithdrawal() { return { decision: 'BLOCK' }; } },
    emit: (e) => events.push(e),
  };

  await scoreAndCount({
    ctx,
    method: 'scoreWithdrawal',
    payload: {},
    results,
    stage: 'fan-out',
  });

  assert.deepEqual(
    events.map((e) => `${e.type}:${e.stage}`),
    ['attempt:fan-out', 'response:fan-out']
  );
  assert.equal(results.blocked, 1);
  assert.equal(results.attempts, 1);
});

// ── the public subpath ──────────────────────────────────────────────────

test('fraud-sim/utils exposes what a custom scenario needs', async () => {
  const utils = await import('../../src/utils/index.js');

  for (const name of [
    'sleep',
    'simulatedClock',
    'newResults',
    'scoreAndCount',
    'buildLoginPayload',
    'buildWithdrawalPayload',
    'buildActionPayload',
    'randomIp',
    'randomFloat',
    'DEMO_IP_POOL',
    'pickDemoIp',
  ]) {
    assert.ok(utils[name] != null, `fraud-sim/utils is missing ${name}`);
  }
});

test('a custom scenario built on fraud-sim/utils is reproducible', async () => {
  const utils = await import('../../src/utils/index.js');

  registerScenario({
    id: 'custom-seeded',
    name: 'Custom',
    description: 'd',
    defaultOptions: { attemptCount: 5 },
    async run(ctx) {
      const results = utils.newResults();
      for (let i = 0; i < ctx.options.attemptCount; i++) {
        await utils.scoreAndCount({
          ctx,
          method: 'scoreLogin',
          payload: utils.buildLoginPayload(`user_${utils.randomInt(1, 1000)}`),
          results,
        });
      }
      return results;
    },
  });

  const fingerprint = async (seed) => {
    const target = allow();
    await run('custom-seeded', { target, seed, ...FAST });
    return target._calls('scoreLogin').map((c) => `${c.user_id}|${c.ip_address}`);
  };

  assert.deepEqual(await fingerprint(1), await fingerprint(1));
  assert.notDeepEqual(await fingerprint(1), await fingerprint(2));

  unregisterScenario('custom-seeded');
});
