import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../../src/index.js';
import { mockAdapter } from '../../src/adapters/mock.js';

test('credential-stuffing requires targetUserId', async () => {
  await assert.rejects(
    run('credential-stuffing', { target: mockAdapter() }),
    /targetUserId/
  );
});

test('credential-stuffing emits attempt + response events for each attempt', async () => {
  const events = [];
  const target = mockAdapter({
    scoreLogin: [{ decision: 'BLOCK', riskScore: 0.9, reasons: [{ code: 'X' }] }],
  });

  await run('credential-stuffing', {
    target,
    options: {
      targetUserId: 'test_user_001',
      attackerCount: 2,
      attemptsPerIp: 2,
      delayMs: 0,
    },
    onEvent: (e) => events.push(e),
  });

  const attempts = events.filter((e) => e.type === 'attempt');
  const responses = events.filter((e) => e.type === 'response');

  assert.equal(attempts.length, 4); // 2 IPs × 2 attempts
  assert.equal(responses.length, 4);
});

test('credential-stuffing respects maxTotalAttempts safety ceiling', async () => {
  const target = mockAdapter({
    scoreLogin: [{ decision: 'BLOCK' }],
  });

  const report = await run('credential-stuffing', {
    target,
    options: {
      targetUserId: 'u1',
      attackerCount: 100,
      attemptsPerIp: 100,
      delayMs: 0,
      maxTotalAttempts: 5,
    },
  });

  assert.equal(report.attempts, 5);
});

test('credential-stuffing produces high block rate when target blocks aggressively', async () => {
  const target = mockAdapter({
    scoreLogin: [{ decision: 'BLOCK' }],
  });

  const report = await run('credential-stuffing', {
    target,
    options: {
      targetUserId: 'u1',
      attackerCount: 10,
      attemptsPerIp: 1,
      delayMs: 0,
    },
  });

  assert.equal(report.blockRate, 1.0);
  assert.equal(report.attempts, 10);
  assert.equal(report.blocked, 10);
});

test('credential-stuffing rotates IPs across attempts', async () => {
  const target = mockAdapter({
    scoreLogin: [{ decision: 'ALLOW' }],
  });

  await run('credential-stuffing', {
    target,
    options: {
      targetUserId: 'u1',
      attackerCount: 5,
      attemptsPerIp: 2,
      delayMs: 0,
    },
  });

  const calls = target._calls('scoreLogin');
  const uniqueIps = new Set(calls.map((c) => c.ip_address));
  // We expect 5 different IPs
  assert.equal(uniqueIps.size, 5);
});

test('credential-stuffing aborts when signal is triggered', async () => {
  const target = mockAdapter({
    scoreLogin: [{ decision: 'ALLOW' }],
  });
  const controller = new AbortController();

  // Abort after a tiny delay
  setTimeout(() => controller.abort(), 50);

  const report = await run('credential-stuffing', {
    target,
    options: {
      targetUserId: 'u1',
      attackerCount: 1000,
      attemptsPerIp: 1,
      delayMs: 100, // Slow enough that abort kicks in
    },
    signal: controller.signal,
  });

  // Should have stopped well before 1000 attempts
  assert.ok(report.attempts < 100, `expected early abort, got ${report.attempts}`);
});

test('account-drain requires targetUserId', async () => {
  await assert.rejects(
    run('account-drain', { target: mockAdapter() }),
    /targetUserId/
  );
});

test('account-drain stops if login is BLOCKed', async () => {
  const target = mockAdapter({
    scoreLogin: [{ decision: 'BLOCK', reasons: [{ code: 'NEW_DEVICE' }] }],
    scoreWithdrawal: [{ decision: 'ALLOW' }],
  });

  const report = await run('account-drain', {
    target,
    options: {
      targetUserId: 'u1',
      withdrawalCount: 5,
      delayBetweenWithdrawalsMs: 0,
      postLoginPauseMs: 0,
    },
  });

  assert.equal(report.loginDecision, 'BLOCK');
  assert.equal(report.attempts, 1); // Only the login attempt happened
  assert.equal(target._calls('scoreWithdrawal').length, 0);
});

test('account-drain proceeds through withdrawals when login is ALLOWed', async () => {
  const target = mockAdapter({
    scoreLogin: [{ decision: 'ALLOW' }],
    scoreWithdrawal: [{ decision: 'ALLOW' }],
  });

  const report = await run('account-drain', {
    target,
    options: {
      targetUserId: 'u1',
      withdrawalCount: 3,
      delayBetweenWithdrawalsMs: 0,
      postLoginPauseMs: 0,
      skipPasswordChange: true,
    },
  });

  assert.equal(report.attempts, 4); // 1 login + 3 withdrawals
  assert.equal(report.attackerSucceeded, true);
});

test('account-drain stops when a withdrawal is BLOCKed', async () => {
  const target = mockAdapter({
    scoreLogin: [{ decision: 'ALLOW' }],
    scoreWithdrawal: [
      { decision: 'ALLOW' },
      { decision: 'ALLOW' },
      { decision: 'BLOCK', reasons: [{ code: 'DRAIN_PATTERN' }] },
    ],
  });

  const report = await run('account-drain', {
    target,
    options: {
      targetUserId: 'u1',
      withdrawalCount: 10,
      delayBetweenWithdrawalsMs: 0,
      postLoginPauseMs: 0,
      skipPasswordChange: true,
    },
  });

  assert.equal(report.attempts, 4); // 1 login + 3 withdrawals (3rd was BLOCK)
  assert.equal(report.blocked, 1);
  assert.equal(report.attackerSucceeded, false);
});
