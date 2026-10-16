/**
 * Mock fraud detection target for examples and integration tests.
 *
 * Implements a simple but realistic rules engine so scenarios produce
 * meaningful block rates. This is NOT FriskLayer — it's a stripped-down
 * pedagogical example showing the kind of system fraud-sim tests against.
 *
 * Covers all three scoring endpoints (`/score/login`, `/score/withdrawal`,
 * `/score/action`), so every shipped scenario can run against it.
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
  cardAuthsByUser: new Map(),   // userId → number of card auths in window
  binsByUser: new Map(),        // userId → Map<bin, count>
  signupsByDevice: new Map(),   // deviceFp → number of signups
  signupsBySubnet: new Map(),   // /24 → number of signups
  payoutAccounts: new Map(),    // payoutAccount → Set<userId>
  sessionOrigin: new Map(),     // sessionId → { device, ip }
};

// Decay counters every minute
setInterval(() => {
  for (const map of [
    seen.loginsByUser,
    seen.loginsByIp,
    seen.newPayeesByUser,
    seen.cardAuthsByUser,
  ]) {
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

  // Remember where this session began, so later activity can be compared to it.
  if (req.body?.session_id) {
    seen.sessionOrigin.set(req.body.session_id, {
      device: device_fingerprint,
      ip: ip_address,
    });
  }

  const decision = score >= 0.65 ? 'BLOCK' : score >= 0.35 ? 'STEP_UP' : 'ALLOW';

  res.json({
    decision,
    risk_score: Math.min(score, 1.0),
    reasons,
  });
});

app.post('/score/withdrawal', (req, res) => {
  const { user_id, transaction, session_id, device_fingerprint, ip_address } = req.body ?? {};
  const reasons = [];
  let score = 0;

  // Rule: session continuity at the point money moves — the check that catches
  // a hijacked session, which never produced a login event of its own.
  if (session_id) {
    const origin = seen.sessionOrigin.get(session_id);
    if (origin && origin.device !== device_fingerprint) {
      reasons.push({ code: 'DEVICE_SESSION_MISMATCH', weight: 0.5 });
      score += 0.5;
    }
    if (origin && origin.ip !== ip_address) {
      reasons.push({ code: 'IP_SESSION_MISMATCH', weight: 0.3 });
      score += 0.3;
    }
  }

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

/**
 * Generic action scoring — signups, promo claims, card authorisations, and
 * in-session activity. The `card-testing`, `promo-abuse` and `session-hijack`
 * scenarios need this endpoint; without it they cannot run at all.
 *
 * As with the rules above, these are pedagogical: enough structure for a
 * scenario to produce a meaningful result, not a real detection engine.
 */
app.post('/score/action', (req, res) => {
  const { user_id, action_type, ip_address, device_fingerprint, session_id, details } =
    req.body ?? {};
  const reasons = [];
  let score = 0;

  const subnet = String(ip_address ?? '').split('.').slice(0, 3).join('.');

  if (action_type === 'card_auth') {
    // Rule: micro-authorisation velocity. Card testers probe fast and cheap.
    const authCount = (seen.cardAuthsByUser.get(user_id) ?? 0) + 1;
    seen.cardAuthsByUser.set(user_id, authCount);
    if (authCount > 8) {
      reasons.push({ code: 'CARD_AUTH_VELOCITY', weight: 0.4 });
      score += 0.4;
    }

    // Rule: BIN concentration. A genuine merchant sees many BINs; a stolen
    // list drawn from one breach sees very few.
    const bins = seen.binsByUser.get(user_id) ?? new Map();
    const bin = details?.card_bin ?? 'unknown';
    bins.set(bin, (bins.get(bin) ?? 0) + 1);
    seen.binsByUser.set(user_id, bins);
    const busiestBin = Math.max(...bins.values());
    if (busiestBin > 5 && bins.size <= 4) {
      reasons.push({ code: 'BIN_CONCENTRATION', weight: 0.35 });
      score += 0.35;
    }

    // Rule: trivial amount, card not present — the shape of a probe.
    if (details?.entry_mode === 'card_not_present' && (details?.amount ?? 0) < 10000) {
      reasons.push({ code: 'MICRO_AUTH_CNP', weight: 0.2 });
      score += 0.2;
    }
  }

  if (action_type === 'signup' || action_type === 'promo_claim') {
    // Rule: device reuse across accounts.
    const perDevice = (seen.signupsByDevice.get(device_fingerprint) ?? 0) + 1;
    seen.signupsByDevice.set(device_fingerprint, perDevice);
    if (perDevice > 3) {
      reasons.push({ code: 'DEVICE_MANY_ACCOUNTS', weight: 0.45 });
      score += 0.45;
    }

    // Rule: subnet clustering.
    const perSubnet = (seen.signupsBySubnet.get(subnet) ?? 0) + 1;
    seen.signupsBySubnet.set(subnet, perSubnet);
    if (perSubnet > 6) {
      reasons.push({ code: 'SUBNET_MANY_SIGNUPS', weight: 0.3 });
      score += 0.3;
    }

    // Rule: payout concentration — many accounts, one destination.
    const payout = details?.payout_account;
    if (payout) {
      const users = seen.payoutAccounts.get(payout) ?? new Set();
      users.add(user_id);
      seen.payoutAccounts.set(payout, users);
      if (users.size > 4) {
        reasons.push({ code: 'PAYOUT_CONCENTRATION', weight: 0.4 });
        score += 0.4;
      }
    }
  }

  // Rule: session continuity. The device and network a session was opened from
  // should be the ones it continues from.
  if (session_id) {
    const origin = seen.sessionOrigin.get(session_id);
    if (!origin) {
      seen.sessionOrigin.set(session_id, { device: device_fingerprint, ip: ip_address });
    } else {
      if (origin.device !== device_fingerprint) {
        reasons.push({ code: 'DEVICE_SESSION_MISMATCH', weight: 0.5 });
        score += 0.5;
      }
      if (origin.ip !== ip_address) {
        reasons.push({ code: 'IP_SESSION_MISMATCH', weight: 0.3 });
        score += 0.3;
      }
    }
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

/**
 * Clear all in-memory state.
 *
 * Test-only. A real fraud system has no such endpoint — but when running
 * several scenarios in sequence against one instance, counters and device
 * history from an earlier scenario leak into a later one and make each
 * scenario look guiltier than it is. Reset between scenarios to measure each
 * attack independently.
 */
app.post('/reset', (req, res) => {
  for (const map of Object.values(seen)) map.clear();
  res.json({ ok: true });
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Mock fraud target listening on http://localhost:${PORT}`);
  console.log('Try: npm run example:basic in another terminal');
});
