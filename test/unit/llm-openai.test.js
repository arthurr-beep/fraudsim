import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openai } from '../../src/llm/openai.js';

const input = {
  scenarioId: 'adaptive-attacker',
  history: [{ round: 1, decision: 'BLOCK', reasons: [{ code: 'IP_REPUTATION' }] }],
  round: 2,
  maxRound: 10,
};

function okFetch(content) {
  return async () => ({
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content } }] }),
  });
}

test('accepts apiKey and model config and reports its name', () => {
  const provider = openai({ apiKey: 'sk-test', model: 'gpt-4o' });
  assert.equal(provider.name, 'openai');
});

test('returns parsed reasoning and parameters for a typical response', async () => {
  const provider = openai({
    apiKey: 'sk-test',
    fetch: okFetch(JSON.stringify({ reasoning: 'change ip', parameters: { ip: '1.2.3.4' } })),
  });
  const strategy = await provider.generateStrategy(input);
  assert.equal(strategy.reasoning, 'change ip');
  assert.equal(strategy.parameters.ip, '1.2.3.4');
});

test('sends the API key as a bearer token', async () => {
  let captured;
  const provider = openai({
    apiKey: 'sk-secret',
    fetch: async (url, opts) => {
      captured = opts;
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"reasoning":"x","parameters":{}}' } }] }) };
    },
  });
  await provider.generateStrategy(input);
  assert.equal(captured.headers.Authorization, 'Bearer sk-secret');
});

test('falls back to a randomised strategy on a non-2xx response', async () => {
  const provider = openai({
    apiKey: 'sk-test',
    fetch: async () => ({ ok: false, status: 429, json: async () => ({}) }),
  });
  const strategy = await provider.generateStrategy(input);
  assert.equal(typeof strategy.reasoning, 'string');
  assert.ok(typeof strategy.parameters.ip === 'string');
});

test('falls back on invalid JSON content', async () => {
  const provider = openai({ apiKey: 'sk-test', fetch: okFetch('not json at all') });
  const strategy = await provider.generateStrategy(input);
  assert.ok(typeof strategy.parameters.ip === 'string');
});

test('falls back on a network error and never throws', async () => {
  const provider = openai({
    apiKey: 'sk-test',
    fetch: async () => {
      throw new Error('connection refused');
    },
  });
  const strategy = await provider.generateStrategy(input);
  assert.equal(typeof strategy.reasoning, 'string');
  assert.ok(strategy.parameters);
});
