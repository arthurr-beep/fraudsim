import { test } from 'node:test';
import assert from 'node:assert/strict';
import { anthropic } from '../../src/llm/anthropic.js';

const input = {
  scenarioId: 'adaptive-attacker',
  history: [{ round: 1, decision: 'BLOCK', reasons: [{ code: 'DEVICE_SESSION_MISMATCH' }] }],
  round: 2,
  maxRound: 10,
};

function okFetch(text) {
  return async () => ({
    ok: true,
    status: 200,
    json: async () => ({ content: [{ type: 'text', text }] }),
  });
}

test('accepts apiKey and model config and reports its name', () => {
  const provider = anthropic({ apiKey: 'sk-ant', model: 'claude-sonnet-5' });
  assert.equal(provider.name, 'anthropic');
});

test('returns valid reasoning and parameters', async () => {
  const provider = anthropic({
    apiKey: 'sk-ant',
    fetch: okFetch(JSON.stringify({ reasoning: 'rotate device', parameters: { deviceFingerprint: 'abc' } })),
  });
  const strategy = await provider.generateStrategy(input);
  assert.equal(strategy.reasoning, 'rotate device');
  assert.equal(strategy.parameters.deviceFingerprint, 'abc');
});

test('sends x-api-key and anthropic-version headers', async () => {
  let captured;
  const provider = anthropic({
    apiKey: 'sk-ant-secret',
    fetch: async (url, opts) => {
      captured = opts;
      return { ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: '{"reasoning":"x","parameters":{}}' }] }) };
    },
  });
  await provider.generateStrategy(input);
  assert.equal(captured.headers['x-api-key'], 'sk-ant-secret');
  assert.equal(captured.headers['anthropic-version'], '2023-06-01');
});

test('extracts JSON even when wrapped in prose', async () => {
  const provider = anthropic({
    apiKey: 'sk-ant',
    fetch: okFetch('Here is my plan: {"reasoning":"wait","parameters":{"delayMs":9000}} — good luck.'),
  });
  const strategy = await provider.generateStrategy(input);
  assert.equal(strategy.parameters.delayMs, 9000);
});

test('falls back to a randomised strategy on API error', async () => {
  const provider = anthropic({
    apiKey: 'sk-ant',
    fetch: async () => ({ ok: false, status: 500, json: async () => ({}) }),
  });
  const strategy = await provider.generateStrategy(input);
  assert.ok(typeof strategy.parameters.deviceFingerprint === 'string');
});

test('falls back on a network error and never throws', async () => {
  const provider = anthropic({
    apiKey: 'sk-ant',
    fetch: async () => {
      throw new Error('timeout');
    },
  });
  const strategy = await provider.generateStrategy(input);
  assert.ok(strategy.parameters);
});
