import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run, listScenarios } from '../../src/index.js';
import { mockAdapter } from '../../src/adapters/mock.js';

const opts = { targetUserId: 'victim_1', maxRounds: 5, delayMs: 0 };

test('adaptive-attacker is registered alongside the full scenario library', () => {
  const scenarios = listScenarios();
  const attacks = scenarios.filter((s) => s.traffic === 'attack').map((s) => s.id);
  assert.ok(attacks.includes('adaptive-attacker'));
  assert.equal(attacks.length, 10);
  assert.deepEqual(
    scenarios.filter((s) => s.traffic === 'legitimate').map((s) => s.id),
    ['legitimate-users']
  );
});

test('adaptive-attacker requires targetUserId', async () => {
  await assert.rejects(run('adaptive-attacker', { target: mockAdapter() }), /targetUserId/);
});

test('runs with the deterministic fallback when no llm is passed', async () => {
  const target = mockAdapter({
    scoreLogin: [{ decision: 'BLOCK', reasons: [{ code: 'IP_REPUTATION' }] }],
  });
  const report = await run('adaptive-attacker', { target, options: opts });
  assert.equal(report.scenarioId, 'adaptive-attacker');
  assert.equal(report.rounds, 5); // never allowed → runs to maxRounds
  assert.equal(report.outcome, 'attacker_defeated');
});

test('stops immediately on ALLOW', async () => {
  const target = mockAdapter({
    scoreLogin: [
      { decision: 'BLOCK', reasons: [{ code: 'IP_REPUTATION' }] },
      { decision: 'ALLOW', reasons: [] },
      { decision: 'BLOCK', reasons: [] },
    ],
  });
  const report = await run('adaptive-attacker', { target, options: opts });
  assert.equal(report.outcome, 'attacker_succeeded');
  assert.equal(report.rounds, 2); // allowed on round 2
  assert.equal(report.allowed, 1);
});

test('stops at maxRounds if no ALLOW is reached', async () => {
  const target = mockAdapter({ scoreLogin: [{ decision: 'BLOCK', reasons: [] }] });
  const report = await run('adaptive-attacker', {
    target,
    options: { ...opts, maxRounds: 3 },
  });
  assert.equal(report.rounds, 3);
  assert.equal(report.outcome, 'attacker_defeated');
});

test('emits attacker_adapts events with reasoning before attempts', async () => {
  const events = [];
  const target = mockAdapter({ scoreLogin: [{ decision: 'BLOCK', reasons: [] }] });
  await run('adaptive-attacker', {
    target,
    options: { ...opts, maxRounds: 3 },
    onEvent: (e) => events.push(e),
  });

  const adapts = events.filter((e) => e.type === 'attacker_adapts');
  assert.equal(adapts.length, 3);
  for (const e of adapts) {
    assert.equal(typeof e.reasoning, 'string');
    assert.ok(e.parameters);
  }

  // Each attacker_adapts must come before the attempt of the same round.
  const firstAdaptIdx = events.findIndex((e) => e.type === 'attacker_adapts' && e.round === 2);
  const firstAttemptIdx = events.findIndex((e) => e.type === 'attempt' && e.round === 2);
  assert.ok(firstAdaptIdx < firstAttemptIdx);
});

test('strategy history is preserved in the report', async () => {
  const target = mockAdapter({ scoreLogin: [{ decision: 'BLOCK', reasons: [] }] });
  const report = await run('adaptive-attacker', {
    target,
    options: { ...opts, maxRounds: 4 },
  });
  assert.equal(report.strategyHistory.length, 4);
  assert.equal(report.strategyHistory[0].round, 1);
  assert.match(report.strategyHistory[0].reasoning, /baseline/i);
});

test('each round is informed by previous rounds (adaptation)', async () => {
  // A custom provider that records the history length it was asked to reason over.
  const seenHistoryLengths = [];
  const recordingLlm = {
    name: 'recording',
    async generateStrategy({ history }) {
      seenHistoryLengths.push(history.length);
      return { reasoning: 'r', parameters: { ip: '9.9.9.9' } };
    },
  };
  const target = mockAdapter({ scoreLogin: [{ decision: 'BLOCK', reasons: [] }] });
  await run('adaptive-attacker', {
    target,
    llm: recordingLlm,
    options: { ...opts, maxRounds: 4 },
  });
  // Round 1 is hardcoded (no LLM call); rounds 2,3,4 call with growing history.
  assert.deepEqual(seenHistoryLengths, [1, 2, 3]);
});

test('the fallback provider is seeded from the run, so seeds change the attack', async () => {
  // A hardcoded provider seed made every seeded run of this scenario identical
  // regardless of the seed the caller passed — silently contradicting the
  // reproducibility feature in the one scenario whose whole point is variation.
  const fingerprint = async (seed) => {
    const target = mockAdapter({
      defaultResponse: { decision: 'BLOCK', reasons: [{ code: 'IP_REPUTATION' }] },
    });
    await run('adaptive-attacker', {
      target,
      options: { targetUserId: 'v', maxRounds: 4, delayMs: 0 },
      seed,
      maxRequestsPerSecond: Infinity,
    });
    return target._calls('scoreLogin').map((c) => c.ip_address).join(',');
  };

  assert.equal(await fingerprint(1), await fingerprint(1), 'same seed must replay');
  assert.notEqual(await fingerprint(1), await fingerprint(2), 'different seeds must differ');
});

test('history records the fingerprint actually sent, including round 1', async () => {
  // Round 1 never names a fingerprint, so the payload builder generates one.
  // The attacker must be told which one it was, or it can never replay it.
  const seen = [];
  const recordingLlm = {
    name: 'recording',
    async generateStrategy({ history }) {
      seen.push(history.map((h) => h.parameters.deviceFingerprint));
      return { reasoning: 'r', parameters: {} };
    },
  };
  const target = mockAdapter({ scoreLogin: [{ decision: 'BLOCK', reasons: [] }] });
  const report = await run('adaptive-attacker', {
    target,
    llm: recordingLlm,
    options: { ...opts, maxRounds: 2 },
  });

  const sent = target._calls('scoreLogin')[0].device_fingerprint;
  assert.ok(sent, 'round 1 sent a fingerprint');
  assert.deepEqual(seen, [[sent]]);
  assert.equal(report.strategyHistory[0].parameters.deviceFingerprint, sent);
});

test('a parameter the strategy omits is kept, not rotated', async () => {
  const ipOnlyLlm = {
    name: 'ip-only',
    async generateStrategy({ round }) {
      return { reasoning: 'rotate ip', parameters: { ip: `10.0.0.${round}` } };
    },
  };
  const target = mockAdapter({ scoreLogin: [{ decision: 'BLOCK', reasons: [] }] });
  await run('adaptive-attacker', {
    target,
    llm: ipOnlyLlm,
    options: { ...opts, maxRounds: 3 },
  });

  const calls = target._calls('scoreLogin');
  assert.deepEqual(
    calls.map((c) => c.ip_address),
    ['197.211.62.14', '10.0.0.2', '10.0.0.3'] // round 1 is the scenario's baseline IP
  );
  assert.equal(new Set(calls.map((c) => c.device_fingerprint)).size, 1);
  assert.equal(new Set(calls.map((c) => c.user_agent)).size, 1);
});

test('an attacker can replay a device that was only challenged', async () => {
  // The hardened example target's deliberate gap, in miniature: an unknown
  // device is challenged and then remembered as seen, so replaying it wins.
  const known = new Set();
  const target = {
    async scoreLogin(payload) {
      if (known.has(payload.device_fingerprint)) return { decision: 'ALLOW', reasons: [] };
      known.add(payload.device_fingerprint);
      return { decision: 'STEP_UP', reasons: [{ code: 'NEW_DEVICE' }] };
    },
  };
  const replayingLlm = {
    name: 'replaying',
    async generateStrategy({ history }) {
      const challenged = history.find((h) => h.decision === 'STEP_UP');
      return {
        reasoning: 'A step-up is not a block. Replaying the challenged device.',
        parameters: { deviceFingerprint: challenged.parameters.deviceFingerprint },
      };
    },
  };

  const report = await run('adaptive-attacker', {
    target,
    llm: replayingLlm,
    options: { ...opts, maxRounds: 5 },
  });
  assert.equal(report.outcome, 'attacker_succeeded');
  assert.equal(report.rounds, 2);
});
