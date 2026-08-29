/**
 * Scenario: credential-stuffing
 *
 * A botnet replays a stolen credential dump against a login endpoint. Attempts
 * come from many IPs, rotate user agents, and — crucially — spray across many
 * *different* user accounts, because a credential dump is a list of victims,
 * not one victim tried repeatedly. This is the most common automated attack
 * against fintech login endpoints.
 *
 * Defensive systems should catch this via:
 *   - LOGIN_VELOCITY_USER (many attempts on one user)
 *   - LOGIN_VELOCITY_IP   (many attempts from one IP)
 *   - IP_MANY_USERS       (one IP trying many user accounts)
 *   - IP_PROXY_VPN        (datacenter / VPN IPs)
 *   - NEW_DEVICE          (every attempt is a new device fingerprint)
 *
 * Realistic block rates against a well-tuned system: 85-95%.
 *
 * ── Calibration note ──────────────────────────────────────────────────
 * The defaults below are deliberately tuned to *cross* the thresholds that
 * typical rule engines ship with, rather than to look gentle. Two settings
 * matter most:
 *
 *   - `attemptsPerIp` must exceed the target's per-IP velocity limit within
 *     its window, or that rule never fires. Common defaults sit near 20 per
 *     5 minutes; the default here is 25.
 *   - `targetUserIds` must contain more accounts than the target's
 *     "one IP, many users" limit (commonly 10), or that rule never fires.
 *
 * A run that stays under both limits will report a low block rate that says
 * nothing about the defence — it only means the attack was too quiet to be
 * worth catching. Turn these *down* to probe where a system's floor is; leave
 * them at the defaults to measure whether it catches an ordinary attack.
 */

import { sleep } from '../utils/sleep.js';
import { buildLoginPayload } from '../utils/faker-helpers.js';
import {
  randomIp,
  randomUserAgent,
  randomFloat,
  pickDemoIp,
  DEMO_IP_POOL,
} from '../utils/random.js';

/**
 * Personas drawn from DEMO_IP_POOL when `ipPersona: 'mixed'`.
 *
 * Includes `domestic` on purpose: a real botnet rents residential proxies in
 * the victim's own country precisely to avoid the geo signals that the other
 * personas trip. An all-foreign mix makes every attempt look identical to the
 * defence, which flatters the block rate and produces a monotonous event feed.
 */
const MIXED_PERSONAS = ['hosting', 'proxy', 'foreign', 'domestic'];

export default {
  id: 'credential-stuffing',
  name: 'Credential stuffing attack',
  description:
    'A botnet replays a stolen credential dump. Distinct IPs, rotating user agents, sprayed across many accounts to evade per-user rate limits.',

  defaultOptions: {
    targetUserIds: null, // required — array of accounts from the "dump"
    targetUserId: null, // back-compat: single account, equivalent to [targetUserId]
    attackerCount: 20, // distinct IPs
    attemptsPerIp: 25, // attempts before rotating IP — must beat per-IP velocity limits
    delayMs: 100, // ms between attempts
    maxTotalAttempts: 500, // safety ceiling — prevents runaway sims
    ipPersona: 'random', // 'random' | 'mixed' | 'domestic' | 'hosting' | 'proxy' | 'foreign'
  },

  async run(ctx) {
    const { options, target, emit, signal } = ctx;

    const userIds = resolveUserIds(options);

    const results = {
      attempts: 0,
      blocked: 0,
      stepUp: 0,
      allowed: 0,
      errors: 0,
    };

    const usersSeen = new Set();

    emit({
      type: 'milestone',
      message:
        `Starting credential stuffing: ${options.attackerCount} IPs × ${options.attemptsPerIp} attempts ` +
        `across ${userIds.length} account${userIds.length === 1 ? '' : 's'} ` +
        `(max ${options.maxTotalAttempts} total)`,
      timestamp: Date.now(),
    });

    if (userIds.length === 1) {
      emit({
        type: 'milestone',
        message:
          'Only one target account supplied — "one IP, many users" detection cannot fire. ' +
          'Pass options.targetUserIds with several accounts to exercise it.',
        timestamp: Date.now(),
      });
    }

    // Draw pool IPs without replacement so each attacker is distinct until the
    // pool is exhausted, then cycle — a real botnet reuses its exits too.
    const ipSource = makeIpSource(options.ipPersona);

    outer: for (let i = 0; i < options.attackerCount; i++) {
      if (signal.aborted) break;

      // Each "attacker" is a different IP + user agent combination
      const attacker = ipSource(i);
      const attackerIp = attacker.ip;
      const userAgent = randomUserAgent();

      for (let j = 0; j < options.attemptsPerIp; j++) {
        if (signal.aborted) break outer;
        if (results.attempts >= options.maxTotalAttempts) break outer;

        // Spray across the dump: this IP walks the account list rather than
        // hammering one user, which is what makes it credential stuffing.
        const userId = userIds[results.attempts % userIds.length];
        usersSeen.add(userId);

        const payload = buildLoginPayload(userId, {
          ip_address: attackerIp,
          user_agent: userAgent,
          // Crucially: new device fingerprint per attempt (botnet behaviour)
        });

        const t0 = Date.now();
        emit({
          type: 'attempt',
          round: results.attempts,
          payload,
          // Present only for pool-backed IPs — lets a target pre-warm its
          // IP-intel cache instead of doing live lookups mid-run.
          ipIntel: attacker.intel,
          timestamp: t0,
        });

        let response;
        try {
          response = await target.scoreLogin(payload);
        } catch (err) {
          results.errors++;
          emit({
            type: 'error',
            message: `Attempt ${results.attempts} failed: ${err.message}`,
            timestamp: Date.now(),
          });
          continue;
        }

        const latencyMs = Date.now() - t0;

        emit({
          type: 'response',
          round: results.attempts,
          response,
          latencyMs,
          timestamp: Date.now(),
        });

        results.attempts++;
        const decision = response?.decision ?? 'ERROR';
        if (decision === 'BLOCK') results.blocked++;
        else if (decision === 'STEP_UP') results.stepUp++;
        else if (decision === 'ALLOW') results.allowed++;
        else results.errors++;

        try {
          await sleep(options.delayMs, signal);
        } catch {
          break outer; // aborted
        }
      }
    }

    return {
      attempts: results.attempts,
      blocked: results.blocked,
      stepUp: results.stepUp,
      allowed: results.allowed,
      errors: results.errors,
      accountsTargeted: usersSeen.size,
    };
  },
};

// ── internals ───────────────────────────────────────────────────────────

/**
 * Accept either `targetUserIds` (preferred) or the legacy single
 * `targetUserId`, and validate.
 */
function resolveUserIds(options) {
  const { targetUserIds, targetUserId } = options;

  if (targetUserIds != null) {
    if (!Array.isArray(targetUserIds) || targetUserIds.length === 0) {
      throw new Error('credential-stuffing: options.targetUserIds must be a non-empty array');
    }
    return targetUserIds;
  }

  if (targetUserId) return [targetUserId];

  throw new Error(
    'credential-stuffing requires options.targetUserIds (an array of accounts), ' +
      'or options.targetUserId for a single account'
  );
}

/**
 * Build a function that returns the i-th attacker's IP and, where known, its
 * declared intel. Pool draws are without replacement until exhausted.
 */
function makeIpSource(persona) {
  if (persona === 'random' || persona == null) {
    return () => ({ ip: randomIp(), intel: undefined });
  }

  if (persona === 'mixed') {
    const shuffled = shuffle(DEMO_IP_POOL.filter((e) => MIXED_PERSONAS.includes(e.persona)));
    return (i) => toAttacker(shuffled[i % shuffled.length]);
  }

  // A single named persona — validate eagerly so a typo fails on the first
  // attacker rather than silently behaving like 'random'.
  pickDemoIp(persona);
  const shuffled = shuffle(DEMO_IP_POOL.filter((e) => e.persona === persona));
  return (i) => toAttacker(shuffled[i % shuffled.length]);
}

function toAttacker(entry) {
  const { ip, ...intel } = entry;
  return { ip, intel };
}

function shuffle(arr) {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(randomFloat() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
