/**
 * End-to-end integration test.
 *
 * Spins up a tiny native HTTP server implementing a simple rules engine,
 * then runs both v0.1 scenarios against it and verifies the expected
 * block rates.
 *
 * No external dependencies — uses Node's built-in `http` module.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { run } from '../../src/index.js';
import { httpAdapter } from '../../src/adapters/http.js';

let server;
let port;

// Naive in-memory rules state
const state = {
  knownDevices: new Map(),    // userId → Set<deviceFp>
  loginCounts: new Map(),     // userId → count
  ipLoginCounts: new Map(),   // ip → count
  newPayeeCounts: new Map(),  // userId → count
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => {
      try {
        resolve(JSON.parse(data || '{}'));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

before(async () => {
  server = http.createServer(async (req, res) => {
    const body = await readBody(req).catch(() => ({}));
    res.setHeader('Content-Type', 'application/json');

    if (req.method === 'POST' && req.url === '/score/login') {
      const { user_id, ip_address, device_fingerprint } = body;
      let score = 0;
      const reasons = [];

      // Velocity per user (lower threshold for testing)
      const uc = (state.loginCounts.get(user_id) ?? 0) + 1;
      state.loginCounts.set(user_id, uc);
      if (uc > 3) { score += 0.45; reasons.push({ code: 'LOGIN_VELOCITY_USER' }); }

      // Velocity per IP
      const ic = (state.ipLoginCounts.get(ip_address) ?? 0) + 1;
      state.ipLoginCounts.set(ip_address, ic);
      if (ic > 2) { score += 0.4; reasons.push({ code: 'LOGIN_VELOCITY_IP' }); }

      // New device — strong signal
      const devs = state.knownDevices.get(user_id) ?? new Set();
      if (!devs.has(device_fingerprint)) {
        score += 0.4;
        reasons.push({ code: 'NEW_DEVICE' });
        devs.add(device_fingerprint);
        state.knownDevices.set(user_id, devs);
      }

      const decision = score >= 0.65 ? 'BLOCK' : score >= 0.35 ? 'STEP_UP' : 'ALLOW';
      res.end(JSON.stringify({ decision, risk_score: Math.min(score, 1), reasons }));
      return;
    }

    if (req.method === 'POST' && req.url === '/score/withdrawal') {
      const { user_id, transaction } = body;
      let score = 0;
      const reasons = [];

      if (transaction?.is_new_payee) {
        score += 0.2;
        reasons.push({ code: 'NEW_PAYEE_FIRST_TXN' });

        const c = (state.newPayeeCounts.get(user_id) ?? 0) + 1;
        state.newPayeeCounts.set(user_id, c);
        if (c >= 3) {
          score += 0.6;
          reasons.push({ code: 'DRAIN_PATTERN' });
        }
        if (transaction.amount > 1000000) {
          score += 0.4;
          reasons.push({ code: 'NEW_PAYEE_HIGH_AMOUNT' });
        }
      }

      const decision = score >= 0.65 ? 'BLOCK' : score >= 0.35 ? 'STEP_UP' : 'ALLOW';
      res.end(JSON.stringify({ decision, risk_score: Math.min(score, 1), reasons }));
      return;
    }

    if (req.method === 'POST' && req.url?.startsWith('/event/')) {
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'not found' }));
  });

  await new Promise((resolve) => {
    server.listen(0, () => {
      port = server.address().port;
      resolve();
    });
  });
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

test('end-to-end: credential-stuffing against rules engine produces high block rate', async () => {
  // Reset state for clean test
  state.knownDevices.clear();
  state.loginCounts.clear();
  state.ipLoginCounts.clear();

  const target = httpAdapter({
    baseUrl: `http://127.0.0.1:${port}`,
    endpoints: {
      scoreLogin: '/score/login',
    },
  });

  const report = await run('credential-stuffing', {
    target,
    options: {
      targetUserId: 'victim_user_e2e_1',
      attackerCount: 10,
      attemptsPerIp: 3,
      delayMs: 0,
    },
  });

  assert.equal(report.attempts, 30);
  // The simulator's attacks should mostly be challenged or blocked.
  // Every attempt uses a new device, every IP is unused, and per-user velocity rises quickly.
  const challengedRate = (report.blocked + report.stepUp) / report.attempts;
  assert.ok(
    challengedRate >= 0.8,
    `expected challengedRate >= 0.8, got ${challengedRate.toFixed(2)} (blocked=${report.blocked}, stepUp=${report.stepUp})`
  );
});

test('end-to-end: account-drain triggers DRAIN_PATTERN on the third new payee', async () => {
  state.newPayeeCounts.clear();
  state.knownDevices.clear();
  state.loginCounts.clear();
  state.ipLoginCounts.clear();

  const target = httpAdapter({
    baseUrl: `http://127.0.0.1:${port}`,
    endpoints: {
      scoreLogin: '/score/login',
      scoreWithdrawal: '/score/withdrawal',
    },
  });

  const report = await run('account-drain', {
    target,
    options: {
      targetUserId: 'victim_user_e2e_2',
      withdrawalCount: 10,
      amountKobo: 500000, // below high-amount threshold so we test pure drain detection
      delayBetweenWithdrawalsMs: 0,
      postLoginPauseMs: 0,
    },
  });

  // Login from new device may be blocked or stepped-up
  // If login passes, withdrawals should be blocked by the 3rd new payee
  if (report.loginDecision !== 'BLOCK') {
    const blockedWithdrawals = report.withdrawalDecisions.filter(
      (w) => w.decision === 'BLOCK'
    );
    assert.ok(
      blockedWithdrawals.length > 0,
      'expected at least one BLOCKed withdrawal due to DRAIN_PATTERN'
    );
    assert.ok(
      !report.attackerSucceeded,
      'attacker should not succeed — drain pattern should catch them'
    );
  }
});
