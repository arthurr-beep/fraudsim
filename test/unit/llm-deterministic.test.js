import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deterministic } from '../../src/llm/deterministic.js';

const baseInput = {
  scenarioId: 'adaptive-attacker',
  history: [],
  round: 2,
  maxRound: 10,
};

test('deterministic provider has a name field', () => {
  assert.equal(deterministic({ seed: 42 }).name, 'deterministic');
});

test('generateStrategy returns a reasoning string and parameters object', async () => {
  const strategy = await deterministic({ seed: 42 }).generateStrategy(baseInput);
  assert.equal(typeof strategy.reasoning, 'string');
  assert.equal(typeof strategy.parameters, 'object');
  assert.ok(strategy.parameters !== null);
});

test('same seed produces identical output for identical input', async () => {
  const a = await deterministic({ seed: 42 }).generateStrategy(baseInput);
  const b = await deterministic({ seed: 42 }).generateStrategy(baseInput);
  assert.deepEqual(a, b);
});

test('different seeds produce different output', async () => {
  const a = await deterministic({ seed: 1 }).generateStrategy(baseInput);
  const b = await deterministic({ seed: 2 }).generateStrategy(baseInput);
  assert.notDeepEqual(a, b);
});

test('IP-based block reasons trigger IP change reasoning', async () => {
  const strategy = await deterministic({ seed: 7 }).generateStrategy({
    ...baseInput,
    history: [{ round: 1, decision: 'BLOCK', reasons: [{ code: 'IP_REPUTATION' }] }],
  });
  assert.match(strategy.reasoning, /IP/i);
  assert.ok(typeof strategy.parameters.ip === 'string');
});

test('device-based block reasons trigger device change reasoning', async () => {
  const strategy = await deterministic({ seed: 7 }).generateStrategy({
    ...baseInput,
    history: [{ round: 1, decision: 'BLOCK', reasons: [{ code: 'DEVICE_SESSION_MISMATCH' }] }],
  });
  assert.match(strategy.reasoning, /device/i);
  assert.ok(typeof strategy.parameters.deviceFingerprint === 'string');
});

test('velocity block reasons trigger a longer delay', async () => {
  const strategy = await deterministic({ seed: 7 }).generateStrategy({
    ...baseInput,
    history: [{ round: 1, decision: 'BLOCK', reasons: [{ code: 'LOGIN_VELOCITY_IP' }] }],
  });
  assert.match(strategy.reasoning, /velocity/i);
  // Velocity path uses the 5000–15000ms range, well above the default 500–3000.
  assert.ok(strategy.parameters.delayMs >= 5000);
});

test('accepts string reason codes as well as objects', async () => {
  const strategy = await deterministic({ seed: 7 }).generateStrategy({
    ...baseInput,
    history: [{ round: 1, decision: 'BLOCK', reasons: ['IP_PROXY_VPN'] }],
  });
  assert.match(strategy.reasoning, /IP/i);
});

test('empty history on round 1 gives a baseline reasoning', async () => {
  const strategy = await deterministic({ seed: 7 }).generateStrategy({
    ...baseInput,
    round: 1,
    history: [],
  });
  assert.match(strategy.reasoning, /baseline/i);
});

test('an IP reason outranks the new-device reason that always accompanies it', async () => {
  // A rotating attacker sees NEW_DEVICE on every response, because rotating is
  // what creates it. If device won the classification, the attacker would
  // announce it was changing fingerprint while the address was what blocked it.
  const strategy = await deterministic({ seed: 7 }).generateStrategy({
    ...baseInput,
    history: [
      {
        round: 1,
        decision: 'BLOCK',
        reasons: [{ code: 'IP_KNOWN_ABUSIVE' }, { code: 'NEW_DEVICE' }],
      },
    ],
  });

  assert.match(strategy.reasoning, /IP-related/);
  assert.match(strategy.reasoning, /fresh IP address/);
});

test('the reasoning says challenged when the attempt was stepped up', async () => {
  const provider = deterministic({ seed: 7 });

  const challenged = await provider.generateStrategy({
    ...baseInput,
    history: [{ round: 1, decision: 'STEP_UP', reasons: [{ code: 'NEW_DEVICE' }] }],
  });
  assert.match(challenged.reasoning, /was challenged/);
  assert.ok(!/was blocked/.test(challenged.reasoning));

  const blocked = await provider.generateStrategy({
    ...baseInput,
    history: [{ round: 1, decision: 'BLOCK', reasons: [{ code: 'NEW_DEVICE' }] }],
  });
  assert.match(blocked.reasoning, /was blocked/);
});
