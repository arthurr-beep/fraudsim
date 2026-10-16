import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runSuite } from '../../src/index.js';
import { mockAdapter } from '../../src/adapters/mock.js';

const SCENARIOS = (n) =>
  Array.from({ length: n }, () => ({
    id: 'credential-stuffing',
    options: { targetUserIds: ['a'], attackerCount: 1, attemptsPerIp: 5, delayMs: 0, maxTotalAttempts: 5 },
  }));

/**
 * Slack for the gap between when the limiter grants a slot and when the target
 * stamps the call. If the first call of a window is stamped a few ms late, the
 * eleventh looks under a second behind it though the limiter held exactly 10/s.
 * Far below the breach this test exists to catch: 25 × concurrency per second.
 */
const JITTER_MS = 50;

/** Largest number of calls landing inside any rolling one-second window. */
function worstWindow(stamps) {
  const sorted = [...stamps].sort((a, b) => a - b);
  let worst = 0;
  for (let i = 0; i < sorted.length; i++) {
    let n = 0;
    for (let j = i; j < sorted.length && sorted[j] - sorted[i] < 1000 - JITTER_MS; j++) n++;
    worst = Math.max(worst, n);
  }
  return worst;
}

function recordingTarget(stamps) {
  return {
    async scoreLogin() {
      stamps.push(Date.now());
      return { decision: 'BLOCK' };
    },
    async scoreWithdrawal() {
      return { decision: 'BLOCK' };
    },
    async scoreAction() {
      return { decision: 'BLOCK' };
    },
    async reportEvent() {},
  };
}

test('runSuite runs sequentially by default', async () => {
  let inFlight = 0;
  let peak = 0;
  const target = {
    async scoreLogin() {
      peak = Math.max(peak, ++inFlight);
      await new Promise((r) => setTimeout(r, 2));
      inFlight--;
      return { decision: 'BLOCK' };
    },
    async scoreWithdrawal() { return { decision: 'BLOCK' }; },
    async scoreAction() { return { decision: 'BLOCK' }; },
    async reportEvent() {},
  };

  await runSuite({ name: 's', target, scenarios: SCENARIOS(3), maxRequestsPerSecond: Infinity });
  assert.equal(peak, 1, 'the default must not run scenarios in parallel');
});

test('concurrency actually overlaps scenarios', async () => {
  let inFlight = 0;
  let peak = 0;
  const target = {
    async scoreLogin() {
      peak = Math.max(peak, ++inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return { decision: 'BLOCK' };
    },
    async scoreWithdrawal() { return { decision: 'BLOCK' }; },
    async scoreAction() { return { decision: 'BLOCK' }; },
    async reportEvent() {},
  };

  await runSuite({
    name: 's',
    target,
    scenarios: SCENARIOS(4),
    concurrency: 3,
    maxRequestsPerSecond: Infinity,
  });

  assert.ok(peak > 1, `expected overlapping requests, peak was ${peak}`);
  assert.ok(peak <= 3, `expected at most 3 concurrent scenarios, peak was ${peak}`);
});

test('the rate ceiling is shared across concurrent scenarios', async () => {
  // The failure this guards against: one limiter per run, so "25 per second"
  // silently becomes 25 × concurrency.
  for (const concurrency of [1, 4]) {
    const stamps = [];
    await runSuite({
      name: 's',
      target: recordingTarget(stamps),
      scenarios: SCENARIOS(4),
      concurrency,
      maxRequestsPerSecond: 10,
    });

    assert.equal(stamps.length, 20);
    assert.ok(
      worstWindow(stamps) <= 10,
      `concurrency=${concurrency} breached the cap: ${worstWindow(stamps)} in one second`
    );
  }
});

test('results keep input order regardless of concurrency', async () => {
  const scenarios = [
    { id: 'slow-drain', options: { targetUserId: 'v', withdrawalCount: 2, delayMs: 0 } },
    { id: 'credential-stuffing', options: { targetUserIds: ['a'], attackerCount: 1, attemptsPerIp: 2, delayMs: 0 } },
    { id: 'session-hijack', options: { targetUserId: 'v', delayMs: 0 } },
  ];

  const result = await runSuite({
    name: 's',
    target: mockAdapter({ defaultResponse: { decision: 'BLOCK' } }),
    scenarios,
    concurrency: 3,
    maxRequestsPerSecond: Infinity,
  });

  assert.deepEqual(
    result.scenarioReports.map((r) => r.scenarioId),
    ['slow-drain', 'credential-stuffing', 'session-hijack']
  );
  assert.equal(result.concurrency, 3);
});

test('a concurrent suite stays seeded per scenario', async () => {
  const fingerprint = async (concurrency) => {
    const seen = [];
    const target = {
      async scoreLogin(p) {
        seen.push(`${p.user_id}|${p.ip_address}`);
        return { decision: 'BLOCK' };
      },
      async scoreWithdrawal() { return { decision: 'BLOCK' }; },
      async scoreAction() { return { decision: 'BLOCK' }; },
      async reportEvent() {},
    };

    await runSuite({
      name: 's',
      target,
      scenarios: [
        { id: 'credential-stuffing', options: { targetUserIds: ['a', 'b'], attackerCount: 2, attemptsPerIp: 2, delayMs: 0 } },
        { id: 'velocity-evasion', options: { targetUserId: 'v', attemptCount: 4, delayMs: 0 } },
      ],
      seed: 99,
      concurrency,
      maxRequestsPerSecond: Infinity,
    });

    return seen.sort();
  };

  // Same seed must give the same payloads whether or not scenarios overlap —
  // this is what AsyncLocalStorage buys over a module-level generator.
  assert.deepEqual(await fingerprint(1), await fingerprint(2));
});

test('runSuite rejects a nonsensical concurrency', async () => {
  const target = mockAdapter({ defaultResponse: { decision: 'ALLOW' } });
  for (const bad of [0, -1, 1.5, 'two']) {
    await assert.rejects(
      runSuite({ name: 's', target, scenarios: SCENARIOS(1), concurrency: bad }),
      /concurrency must be a positive integer/
    );
  }
});
