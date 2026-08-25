/**
 * Mock fraud detection target for examples and integration tests.
 *
 * Implements a simple but realistic rules engine so scenarios produce
 * meaningful block rates. This is NOT FriskLayer — it's a stripped-down
 * pedagogical example showing the kind of system fraud-sim tests against.
 *
 * Run: `npm run example:mock-target`
 * Then point a scenario at http://localhost:4000
 */

import express from 'express';

const app = express();
app.use(express.json());

// In-memory state — naive but enough for demos
const seen = {
  devicesByUser: new Map(),     // userId → Set<deviceFp>
  loginsByUser: new Map(),      // userId → number (count in last 10 min)
  loginsByIp: new Map(),        // ip → number
  payeesByUser: new Map(),      // userId → Set<payeeAccount>
  newPayeesByUser: new Map(),   // userId → number of new payees in last 30 min
};

// Decay counters every minute
setInterval(() => {
  for (const map of [seen.loginsByUser, seen.loginsByIp, seen.newPayeesByUser]) {
    for (const [key, count] of map) {
      const next = Math.floor(count * 0.5);
      if (next === 0) map.delete(key);
      else map.set(key, next);
    }
  }
}, 60000);

app.post('/score/login', (req, res) => {
  const { user_id, ip_address, device_fingerprint } = req.body ?? {};
  const reasons = [];
  let score = 0;

  // Increment counters
  seen.loginsByUser.set(user_id, (seen.loginsByUser.get(user_id) ?? 0) + 1);
  seen.loginsByIp.set(ip_address, (seen.loginsByIp.get(ip_address) ?? 0) + 1);

  // Rule: velocity per user
  if ((seen.loginsByUser.get(user_id) ?? 0) > 5) {
    reasons.push({ code: 'LOGIN_VELOCITY_USER', weight: 0.35 });
    score += 0.35;
  }

  // Rule: velocity per IP
  if ((seen.loginsByIp.get(ip_address) ?? 0) > 3) {
    reasons.push({ code: 'LOGIN_VELOCITY_IP', weight: 0.4 });
    score += 0.4;
  }

  // Rule: new device
  const userDevices = seen.devicesByUser.get(user_id) ?? new Set();
  if (!userDevices.has(device_fingerprint)) {
    reasons.push({ code: 'NEW_DEVICE', weight: 0.25 });
    score += 0.25;
    userDevices.add(device_fingerprint);
    seen.devicesByUser.set(user_id, userDevices);
  }

  const decision = score >= 0.65 ? 'BLOCK' : score >= 0.35 ? 'STEP_UP' : 'ALLOW';

  res.json({
    decision,
    risk_score: Math.min(score, 1.0),
    reasons,
  });
});

app.post('/score/withdrawal', (req, res) => {
  const { user_id, transaction } = req.body ?? {};
  const reasons = [];
  let score = 0;

  // Rule: new payee
  if (transaction?.is_new_payee) {
    reasons.push({ code: 'NEW_PAYEE_FIRST_TXN', weight: 0.2 });
    score += 0.2;

    const newCount = (seen.newPayeesByUser.get(user_id) ?? 0) + 1;
    seen.newPayeesByUser.set(user_id, newCount);

    // Rule: drain pattern (3+ new payees within tracked window)
    if (newCount >= 3) {
      reasons.push({ code: 'DRAIN_PATTERN', weight: 0.6 });
      score += 0.6;
    }
  }

  // Rule: high amount + new payee
  if (transaction?.is_new_payee && transaction.amount > 1000000) {
    reasons.push({ code: 'NEW_PAYEE_HIGH_AMOUNT', weight: 0.4 });
    score += 0.4;
  }

  const decision = score >= 0.65 ? 'BLOCK' : score >= 0.35 ? 'STEP_UP' : 'ALLOW';

  res.json({
    decision,
    risk_score: Math.min(score, 1.0),
    reasons,
  });
});

app.post('/event/:type', (req, res) => {
  // Accept and discard — this mock doesn't process side events
  res.json({ ok: true });
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Mock fraud target listening on http://localhost:${PORT}`);
  console.log('Try: npm run example:basic in another terminal');
});
