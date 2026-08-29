import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mockAdapter, loggingAdapter } from '../../src/adapters/index.js';
import { httpAdapter } from '../../src/adapters/http.js';

test('mockAdapter returns queued responses in order', async () => {
  const target = mockAdapter({
    scoreLogin: [
      { decision: 'ALLOW', riskScore: 0.1, reasons: [] },
      { decision: 'STEP_UP', riskScore: 0.5, reasons: [{ code: 'X' }] },
      { decision: 'BLOCK', riskScore: 0.9, reasons: [{ code: 'Y' }] },
    ],
  });

  const r1 = await target.scoreLogin({});
  const r2 = await target.scoreLogin({});
  const r3 = await target.scoreLogin({});

  assert.equal(r1.decision, 'ALLOW');
  assert.equal(r2.decision, 'STEP_UP');
  assert.equal(r3.decision, 'BLOCK');
});

test('mockAdapter repeats the last response when the queue is exhausted', async () => {
  const target = mockAdapter({
    scoreLogin: [{ decision: 'BLOCK' }],
  });

  const r1 = await target.scoreLogin({});
  const r2 = await target.scoreLogin({});
  const r3 = await target.scoreLogin({});

  assert.equal(r1.decision, 'BLOCK');
  assert.equal(r2.decision, 'BLOCK');
  assert.equal(r3.decision, 'BLOCK');
});

test('mockAdapter records calls for inspection', async () => {
  const target = mockAdapter();
  await target.scoreLogin({ user_id: 'u1' });
  await target.scoreLogin({ user_id: 'u2' });

  const calls = target._calls('scoreLogin');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].user_id, 'u1');
  assert.equal(calls[1].user_id, 'u2');
});

test('mockAdapter uses defaultResponse when the queue is empty', async () => {
  const target = mockAdapter({
    defaultResponse: { decision: 'STEP_UP', riskScore: 0.5 },
  });

  const r = await target.scoreLogin({});
  assert.equal(r.decision, 'STEP_UP');
});

test('loggingAdapter returns ALLOW by default', async () => {
  const logs = [];
  const target = loggingAdapter({ logger: (...args) => logs.push(args) });

  const r = await target.scoreLogin({ user_id: 'x' });
  assert.equal(r.decision, 'ALLOW');
  assert.ok(logs.length > 0);
});

test('httpAdapter requires baseUrl', () => {
  assert.throws(() => httpAdapter({}), /baseUrl/);
  assert.throws(() => httpAdapter(), /baseUrl/);
});

test('httpAdapter maps responses via responseMap', async () => {
  let capturedRequest;
  const fakeFetch = async (url, opts) => {
    capturedRequest = { url, body: JSON.parse(opts.body) };
    return {
      ok: true,
      status: 200,
      json: async () => ({
        decision: 'BLOCK',
        risk_score: 0.91,
        reasons: [{ code: 'NEW_DEVICE' }],
      }),
    };
  };

  const target = httpAdapter({
    baseUrl: 'https://example.com',
    fetch: fakeFetch,
  });

  const result = await target.scoreLogin({ user_id: 'u1' });

  assert.equal(capturedRequest.url, 'https://example.com/v1/score/login');
  assert.equal(capturedRequest.body.user_id, 'u1');
  assert.equal(result.decision, 'BLOCK');
  assert.equal(result.riskScore, 0.91);
  assert.equal(result.reasons[0].code, 'NEW_DEVICE');
});

const failingFetch = (status, headers = {}) => async () => ({
  ok: false,
  status,
  json: async () => ({ error: 'boom' }),
  headers: { get: (k) => headers[k] ?? null },
});

test('httpAdapter reports HTTP failures as errors, not blocks', async () => {
  // If a 429 or a 503 counted as a BLOCK, rate-limiting the simulator or
  // crashing the target would *raise* its measured block rate — the benchmark
  // would reward a target for falling over.
  const cases = [
    [429, 'RATE_LIMITED'],
    [500, 'SERVER_ERROR'],
    [503, 'SERVER_ERROR'],
    [401, 'AUTH_ERROR'],
    [403, 'AUTH_ERROR'],
    [404, 'ENDPOINT_NOT_FOUND'],
    [418, 'HTTP_ERROR'],
  ];

  for (const [status, code] of cases) {
    const target = httpAdapter({ baseUrl: 'https://example.com', fetch: failingFetch(status) });
    const result = await target.scoreLogin({});

    assert.equal(result.decision, 'ERROR', `HTTP ${status} should not be a decision`);
    assert.equal(result.reasons[0].code, code);
    assert.equal(result.httpStatus, status);
    assert.equal(result.infraError, true);
    assert.equal(result.riskScore, null);
  }
});

test('httpAdapter treats a status as a block only when told to', async () => {
  const target = httpAdapter({
    baseUrl: 'https://example.com',
    fetch: failingFetch(403),
    blockOnStatus: [403],
  });

  const result = await target.scoreLogin({});
  assert.equal(result.decision, 'BLOCK');
  assert.equal(result.reasons[0].code, 'HTTP_BLOCK');
  assert.equal(result.httpStatus, 403);
  assert.ok(!result.infraError);
});

test('httpAdapter surfaces Retry-After when the target rate-limits', async () => {
  const target = httpAdapter({
    baseUrl: 'https://example.com',
    fetch: failingFetch(429, { 'retry-after': '30' }),
  });

  const result = await target.scoreLogin({});
  assert.equal(result.retryAfter, '30');
});

test('httpAdapter handles network errors as ERROR decision', async () => {
  const fakeFetch = async () => {
    throw new Error('connection refused');
  };

  const target = httpAdapter({
    baseUrl: 'https://example.com',
    fetch: fakeFetch,
  });

  const result = await target.scoreLogin({});
  assert.equal(result.decision, 'ERROR');
  assert.equal(result.infraError, true);
  assert.match(result.reasons[0].label, /connection refused/);
});

test('httpAdapter applies custom responseMap', async () => {
  const fakeFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ verdict: 'reject', score: 95 }),
  });

  const target = httpAdapter({
    baseUrl: 'https://example.com',
    fetch: fakeFetch,
    responseMap: (raw) => ({
      decision: raw.verdict === 'reject' ? 'BLOCK' : 'ALLOW',
      riskScore: raw.score / 100,
      reasons: [],
      raw,
    }),
  });

  const result = await target.scoreLogin({});
  assert.equal(result.decision, 'BLOCK');
  assert.equal(result.riskScore, 0.95);
});
