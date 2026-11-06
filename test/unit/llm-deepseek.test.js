import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deepseek } from '../../src/llm/deepseek.js';

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

function capturingFetch(sink) {
  return async (url, opts) => {
    sink.url = url;
    sink.opts = opts;
    sink.body = JSON.parse(opts.body);
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"reasoning":"x","parameters":{}}' } }] }) };
  };
}

test('accepts apiKey and model config and reports its name', () => {
  const provider = deepseek({ apiKey: 'sk-test', model: 'deepseek-v4-pro' });
  assert.equal(provider.name, 'deepseek');
});

test('returns parsed reasoning and parameters for a typical response', async () => {
  const provider = deepseek({
    apiKey: 'sk-test',
    fetch: okFetch(JSON.stringify({ reasoning: 'change ip', parameters: { ip: '1.2.3.4' } })),
  });
  const strategy = await provider.generateStrategy(input);
  assert.equal(strategy.reasoning, 'change ip');
  assert.equal(strategy.parameters.ip, '1.2.3.4');
});

test('calls the DeepSeek endpoint with the API key as a bearer token', async () => {
  const captured = {};
  const provider = deepseek({ apiKey: 'sk-secret', fetch: capturingFetch(captured) });
  await provider.generateStrategy(input);
  assert.equal(captured.url, 'https://api.deepseek.com/chat/completions');
  assert.equal(captured.opts.headers.Authorization, 'Bearer sk-secret');
  assert.equal(captured.body.model, 'deepseek-flash');
  assert.deepEqual(captured.body.response_format, { type: 'json_object' });
});

test('asks for JSON in the prompt, which JSON output requires', async () => {
  const captured = {};
  const provider = deepseek({ apiKey: 'sk-test', fetch: capturingFetch(captured) });
  await provider.generateStrategy(input);
  const prompt = captured.body.messages.map((m) => m.content).join('\n');
  assert.match(prompt, /json/i);
});

test('turns thinking off by default and sends temperature', async () => {
  const captured = {};
  const provider = deepseek({ apiKey: 'sk-test', fetch: capturingFetch(captured) });
  await provider.generateStrategy(input);
  assert.deepEqual(captured.body.thinking, { type: 'disabled' });
  assert.equal(captured.body.temperature, 0.7);
  assert.equal(captured.body.reasoning_effort, undefined);
});

test('with thinking on, sends reasoning effort and drops temperature', async () => {
  const captured = {};
  const provider = deepseek({
    apiKey: 'sk-test',
    thinking: true,
    reasoningEffort: 'low',
    fetch: capturingFetch(captured),
  });
  await provider.generateStrategy(input);
  assert.deepEqual(captured.body.thinking, { type: 'enabled' });
  assert.equal(captured.body.reasoning_effort, 'low');
  assert.equal(captured.body.temperature, undefined);
});

test('honours a custom baseUrl, with or without a trailing slash', async () => {
  const captured = {};
  const provider = deepseek({
    apiKey: 'sk-test',
    baseUrl: 'https://proxy.example.com/deepseek/',
    fetch: capturingFetch(captured),
  });
  await provider.generateStrategy(input);
  assert.equal(captured.url, 'https://proxy.example.com/deepseek/chat/completions');
});

test('falls back when JSON mode returns only whitespace', async () => {
  const provider = deepseek({ apiKey: 'sk-test', fetch: okFetch('   \n  ') });
  const strategy = await provider.generateStrategy(input);
  assert.ok(typeof strategy.parameters.ip === 'string');
});

test('falls back to a randomised strategy on a non-2xx response', async () => {
  const provider = deepseek({
    apiKey: 'sk-test',
    fetch: async () => ({ ok: false, status: 402, json: async () => ({}) }),
  });
  const strategy = await provider.generateStrategy(input);
  assert.equal(typeof strategy.reasoning, 'string');
  assert.ok(typeof strategy.parameters.ip === 'string');
});

test('falls back on a network error and never throws', async () => {
  const provider = deepseek({
    apiKey: 'sk-test',
    fetch: async () => {
      throw new Error('connection refused');
    },
  });
  const strategy = await provider.generateStrategy(input);
  assert.equal(typeof strategy.reasoning, 'string');
  assert.ok(strategy.parameters);
});
