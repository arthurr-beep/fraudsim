/**
 * Hardened mock fraud target — the one that makes an attacker work for it.
 *
 * The basic example target (`examples/express-mock-target`) has a gap the
 * adaptive attacker walks straight through: a first login from an unknown
 * device scores below the challenge threshold, so the attacker wins on move one
 * and never has to adapt. That is a fine demonstration of a cold-start weakness
 * and a poor demonstration of an adaptive adversary.
 *
 * This target closes that gap. Its central rule is simple and strict:
 *
 *   **An unrecognised device is never allowed outright — only challenged.**
 *
 * That single decision is what defeats an attacker whose whole strategy is
 * rotation. Rotating the IP can get you from BLOCK back to STEP_UP; nothing you
 * rotate gets you to ALLOW, because rotating *creates* the unrecognised device
 * that triggers the challenge.
 *
 * Supporting rules:
 *   - **IP reputation** — ~57% of address space is treated as known-abusive, so
 *     an attacker's exit is usually burned and it has to keep looking.
 *   - **Device recidivism** — a fingerprint present on a blocked attempt is
 *     refused permanently, so a burned device cannot come back.
 *   - **Rotation and velocity** — many networks or many attempts against one
 *     account in a short window add score, so a long campaign gets harder.
 *
 * ── The gap this target deliberately leaves ───────────────────────────
 * A device that was only *challenged* is remembered as seen, not as bad. Replay
 * it from a clean IP and you get an ALLOW. The shipped deterministic attacker
 * never finds this, because it rotates its fingerprint every single round. An
 * attacker that reasons "step-up is not a block — reuse that device" beats this
 * target immediately.
 *
 * That asymmetry is the point of running both targets. Against the simple
 * target the difference between a scripted and an adaptive adversary does not
 * show up, because everything wins on move one. Here it does: the same scenario
 * is defeated with the deterministic provider and can succeed with a capable
 * LLM behind it.
 *
 * Run: `npm run example:hardened-target`   → http://localhost:4001
 * Then: `npm run example:adaptive-hardened`
 *
 * Still a teaching implementation, not a production engine. In particular,
 * challenging every unrecognised device is a real trade: it stops this attacker
 * and it puts a step-up in front of every customer who buys a new phone.
 */


import express from 'express';

const app = express();
app.use(express.json());

// ── configuration ───────────────────────────────────────────────────────

const WEIGHTS = {
  NEW_DEVICE: 0.35,
  IP_KNOWN_ABUSIVE: 0.55,
  IP_ROTATION_PATTERN: 0.3,
  LOGIN_VELOCITY_USER: 0.35,
};

const THRESHOLDS = { allowMax: 0.35, blockMin: 0.6 };

/**
 * Synthetic IP reputation. Roughly 57% of the first-octet space is treated as
 * known-abusive — high, but not unrealistic for a list that includes hosting
 * and proxy ranges, and high enough that an attacker's opening exit usually
 * fails. These are invented ranges for the demo, not real reputation data.
 */
const ABUSIVE_OCTET_RANGES = [
  [1, 50],
  [100, 140],
  [200, 254],
];

/** Distinct networks per user before rotation itself becomes the signal. */
const ROTATION_LIMIT = 6;

/** Attempts per user, in-window, before velocity fires. */
const VELOCITY_LIMIT = 8;

// ── state ───────────────────────────────────────────────────────────────

const seen = {
  attemptsByUser: new Map(), // userId → count in window
  networksByUser: new Map(), // userId → Set<first octet>
  devicesByUser: new Map(), // userId → Set<fingerprint>
  blockedDevices: new Set(), // fingerprints refused on sight
  blockedIps: new Set(),
};

// Decay the windowed counters, as a real engine's TTLs would.
setInterval(() => {
  for (const [user, count] of seen.attemptsByUser) {
    const next = Math.floor(count * 0.5);
    if (next === 0) seen.attemptsByUser.delete(user);
    else seen.attemptsByUser.set(user, next);
  }
  seen.networksByUser.clear();
}, 60000);

// ── scoring ─────────────────────────────────────────────────────────────

function isAbusive(ip) {
  const octet = Number(String(ip).split('.')[0]);
  if (!Number.isInteger(octet)) return false;
  return ABUSIVE_OCTET_RANGES.some(([lo, hi]) => octet >= lo && octet <= hi);
}

function isBrowserAgent(ua) {
  return typeof ua === 'string' && /Mozilla\/5\.0/.test(ua);
}

app.post('/score/login', (req, res) => {
  const { user_id, ip_address, device_fingerprint, user_agent } = req.body ?? {};
  const reasons = [];
  let score = 0;
  let forceBlock = false;

  const add = (code, weight, hard = false) => {
    reasons.push({ code, weight });
    score += weight;
    if (hard) forceBlock = true;
  };

  // A tool user agent is not a person. Refused outright, which is why the
  // adaptive attacker's browser-agent baseline is the right opening move.
  if (!isBrowserAgent(user_agent)) {
    add('UA_NOT_BROWSER', 1, true);
  }

  // A fingerprint that was present on a blocked attempt does not get a second
  // chance — so a working device cannot simply be replayed.
  if (device_fingerprint && seen.blockedDevices.has(device_fingerprint)) {
    add('DEVICE_RECIDIVIST', 1, true);
  }

  if (ip_address && seen.blockedIps.has(ip_address)) {
    add('IP_PREVIOUSLY_BLOCKED', 1, true);
  }

  if (isAbusive(ip_address)) {
    add('IP_KNOWN_ABUSIVE', WEIGHTS.IP_KNOWN_ABUSIVE);
  }

  const attempts = (seen.attemptsByUser.get(user_id) ?? 0) + 1;
  seen.attemptsByUser.set(user_id, attempts);
  if (attempts > VELOCITY_LIMIT) {
    add('LOGIN_VELOCITY_USER', WEIGHTS.LOGIN_VELOCITY_USER);
  }

  // Rotation as a signal. One person does not reach an account from four
  // unrelated networks in a few minutes; an attacker burning through exits
  // does exactly that.
  const networks = seen.networksByUser.get(user_id) ?? new Set();
  networks.add(String(ip_address).split('.')[0]);
  seen.networksByUser.set(user_id, networks);
  if (networks.size > ROTATION_LIMIT) {
    add('IP_ROTATION_PATTERN', WEIGHTS.IP_ROTATION_PATTERN);
  }

  const devices = seen.devicesByUser.get(user_id) ?? new Set();
  if (device_fingerprint && !devices.has(device_fingerprint)) {
    add('NEW_DEVICE', WEIGHTS.NEW_DEVICE);
    devices.add(device_fingerprint);
    seen.devicesByUser.set(user_id, devices);
  }

  const riskScore = Math.min(score, 1);
  const decision =
    forceBlock || riskScore >= THRESHOLDS.blockMin
      ? 'BLOCK'
      : riskScore >= THRESHOLDS.allowMax
        ? 'STEP_UP'
        : 'ALLOW';

  // Remember what we refused. This is the memory that makes rotation the only
  // way forward, and eventually makes rotation itself expensive.
  if (decision === 'BLOCK') {
    if (device_fingerprint) seen.blockedDevices.add(device_fingerprint);
    if (ip_address) seen.blockedIps.add(ip_address);
  }

  res.json({ decision, risk_score: riskScore, reasons });
});

// Withdrawals and actions reuse the simple target's posture — this example
// exists to harden the *login* path, which is where adaptation happens.
app.post('/score/withdrawal', (req, res) => {
  const { transaction } = req.body ?? {};
  const reasons = [];
  let score = 0;

  if (transaction?.is_new_payee) {
    reasons.push({ code: 'NEW_PAYEE_FIRST_TXN', weight: 0.3 });
    score += 0.3;
  }
  if (transaction?.is_new_payee && transaction.amount > 5000000) {
    reasons.push({ code: 'NEW_PAYEE_HIGH_AMOUNT', weight: 0.45 });
    score += 0.45;
  }

  const decision = score >= 0.6 ? 'BLOCK' : score >= 0.35 ? 'STEP_UP' : 'ALLOW';
  res.json({ decision, risk_score: Math.min(score, 1), reasons });
});

app.post('/score/action', (req, res) => {
  res.json({ decision: 'ALLOW', risk_score: 0, reasons: [] });
});

app.post('/event/:type', (req, res) => res.json({ ok: true }));

/** Test-only, as in the simple target — see its /reset for why. */
app.post('/reset', (req, res) => {
  seen.attemptsByUser.clear();
  seen.networksByUser.clear();
  seen.devicesByUser.clear();
  seen.blockedDevices.clear();
  seen.blockedIps.clear();
  res.json({ ok: true });
});

app.get('/health', (req, res) => res.json({ status: 'ok', profile: 'hardened' }));

const PORT = process.env.PORT || 4001;
app.listen(PORT, () => {
  console.log(`Hardened mock fraud target listening on http://localhost:${PORT}`);
  console.log('Try: npm run example:adaptive-hardened in another terminal');
});
