import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run, listScenarios } from '../../src/index.js';
import { mockAdapter } from '../../src/adapters/mock.js';

const opts = { targetUserId: 'victim_1', maxRounds: 5, delayMs: 0 };

test('adaptive-attacker is registered alongside the full scenario library', () => {
  const ids = listScenarios().map((s) => s.id);
  assert.ok(ids.includes('adaptive-attacker'));
  assert.equal(ids.length, 10);
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
