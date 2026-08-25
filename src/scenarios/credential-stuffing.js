/**
 * Scenario: credential-stuffing
 *
 * A botnet attempts to authenticate using stolen credentials. Each attempt
 * comes from a different IP, rotates user agents, and paces attempts to
 * evade naive rate limits. This is the most common automated attack against
 * fintech login endpoints.
 *
 * Defensive systems should catch this via:
 *   - LOGIN_VELOCITY_USER (many attempts on one user)
 *   - LOGIN_VELOCITY_IP   (many attempts from one IP)
 *   - IP_PROXY_VPN        (datacenter / VPN IPs)
 *   - IP_MANY_USERS       (one IP trying many user accounts)
 *   - NEW_DEVICE          (every attempt is a new device fingerprint)
 *
 * Realistic block rates against a well-tuned system: 85-95%.
 */

import { sleep } from '../utils/sleep.js';
import { buildLoginPayload } from '../utils/faker-helpers.js';
import { randomIp, randomUserAgent } from '../utils/random.js';

export default {
  id: 'credential-stuffing',
  name: 'Credential stuffing attack',
  description:
    'A botnet attempts to authenticate using stolen credentials. Distinct IPs, rotating user agents, paced to evade simple rate limits.',

  defaultOptions: {
    targetUserId: null, // required
    attackerCount: 50, // distinct IPs
    attemptsPerIp: 3, // attempts before rotating IP
    delayMs: 200, // ms between attempts
    maxTotalAttempts: 200, // safety ceiling — prevents runaway sims
  },

  async run(ctx) {
    const { options, target, emit, signal } = ctx;

    if (!options.targetUserId) {
      throw new Error('credential-stuffing requires options.targetUserId');
    }

    const results = {
      attempts: 0,
      blocked: 0,
      stepUp: 0,
      allowed: 0,
      errors: 0,
    };

    emit({
      type: 'milestone',
      message: `Starting credential stuffing: ${options.attackerCount} IPs × ${options.attemptsPerIp} attempts (max ${options.maxTotalAttempts} total)`,
      timestamp: Date.now(),
    });

    outer: for (let i = 0; i < options.attackerCount; i++) {
      if (signal.aborted) break;

      // Each "attacker IP" is a different IP + user agent combination
      const attackerIp = randomIp();
      const userAgent = randomUserAgent();

      for (let j = 0; j < options.attemptsPerIp; j++) {
        if (signal.aborted) break outer;
        if (results.attempts >= options.maxTotalAttempts) break outer;

        const payload = buildLoginPayload(options.targetUserId, {
          ip_address: attackerIp,
          user_agent: userAgent,
          // Crucially: new device fingerprint per attempt (botnet behaviour)
        });

        const t0 = Date.now();
        emit({ type: 'attempt', round: results.attempts, payload, timestamp: t0 });

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
    };
  },
};
