/**
 * Demo target for the adaptive-attacker scenario.
 *
 * The stock mock target (examples/express-mock-target) is too permissive to
 * show adaptation — a single rotated login passes it on the first try, so the
 * attacker "wins" round 1 and never has to adapt. This target adds an
 * IP-reputation rule that blocks the scenario's baseline IP, so the attacker
 * gets blocked, sees why, rotates, and probes again — which is the whole point
 * of the scenario.
 *
 * It is still a naive per-request defense with a real weakness: it scores each
 * attempt in isolation, so an attacker who rotates IP and device on every
 * attempt eventually presents a "clean" request it can't distinguish from a
 * legitimate login. That weakness is what the adaptive attacker exploits.
 *
 * Run: node examples/adaptive-attacker-demo/demo-target.js
 * Then: node examples/adaptive-attacker-demo/index.js   (in another terminal)
 */

import express from 'express';

const app = express();
app.use(express.json());

// IPs (and their /24s) flagged as abusive. The scenario's default baselineIp
// lives here so round 1 is always blocked on reputation.
const KNOWN_BAD_IPS = new Set(['197.211.62.14']);
const badSubnets = new Set([subnet24('197.211.62.14')]);

// Devices this target has ever seen, per user.
const devicesByUser = new Map();
// Recent login count per user (decays).
const loginsByUser = new Map();

setInterval(() => {
  for (const [user, count] of loginsByUser) {
    const next = Math.floor(count * 0.5);
    if (next === 0) loginsByUser.delete(user);
    else loginsByUser.set(user, next);
  }
}, 60000);

function subnet24(ip) {
  return ip.split('.').slice(0, 3).join('.');
}

app.post('/score/login', (req, res) => {
  const { user_id, ip_address, device_fingerprint } = req.body ?? {};
  const reasons = [];
  let score = 0;

  // Rule: IP reputation. A known-bad IP (or one in a flagged /24) is a hard hit.
  if (KNOWN_BAD_IPS.has(ip_address) || badSubnets.has(subnet24(ip_address ?? ''))) {
    reasons.push({ code: 'IP_REPUTATION', weight: 0.7 });
    score += 0.7;
  }

  // Rule: new device for this user.
  const userDevices = devicesByUser.get(user_id) ?? new Set();
  if (!userDevices.has(device_fingerprint)) {
    reasons.push({ code: 'NEW_DEVICE', weight: 0.2 });
    score += 0.2;
    userDevices.add(device_fingerprint);
    devicesByUser.set(user_id, userDevices);
  }

  // Rule: login velocity per user.
  const logins = (loginsByUser.get(user_id) ?? 0) + 1;
  loginsByUser.set(user_id, logins);
  if (logins > 4) {
    reasons.push({ code: 'LOGIN_VELOCITY_USER', weight: 0.35 });
    score += 0.35;
  }

  const decision = score >= 0.6 ? 'BLOCK' : score >= 0.35 ? 'STEP_UP' : 'ALLOW';
  res.json({ decision, risk_score: Math.min(score, 1), reasons });
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 4100;
app.listen(PORT, () => {
  console.log(`Adaptive-attacker demo target listening on http://localhost:${PORT}`);
  console.log('Now run:  node examples/adaptive-attacker-demo/index.js');
});
