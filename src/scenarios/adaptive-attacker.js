/**
 * Scenario: adaptive-attacker
 *
 * The headline scenario. An attacker probes a login endpoint and, after each
 * block, asks an LLM (via ctx.llm) what to change for the next attempt. Round
 * by round it rotates IPs, device fingerprints, user agents, and timing based
 * on the reasons the defender returned — the same loop a real adaptive actor
 * runs, made visible.
 *
 * The demo moment is the `attacker_adapts` event: it carries the LLM's
 * reasoning and is emitted BEFORE each adapted attempt is sent, so a dashboard
 * can show *why* the attacker is about to do what it does.
 *
 * Defensive systems should catch this via the same signals as credential
 * stuffing (IP reputation, device mismatch, velocity), but the point of the
 * scenario is to see whether a defender holds up as the attacker learns.
 *
 * Works with no LLM: if `ctx.llm` is undefined it falls back to the seeded
 * deterministic provider, so the scenario is fully reproducible in CI.
 */

import { sleep } from '../utils/sleep.js';
import { buildLoginPayload } from '../utils/faker-helpers.js';
import { deterministic } from '../llm/deterministic.js';

export default {
  id: 'adaptive-attacker',
  name: 'LLM adaptive attacker',
  description:
    'An attacker that uses an LLM to adapt its login strategy based on which attempts get blocked.',

  defaultOptions: {
    targetUserId: null, // required
    maxRounds: 10,
    baselineIp: '197.211.62.14', // realistic residential starting point
    delayMs: 1000, // wall-clock pacing between rounds (the attacker's own
    //                chosen delay is recorded, not enacted — see run())
    // The LLM is passed via ctx.llm, not options.
  },

  async run(ctx) {
    const { options, target, emit, signal } = ctx;

    if (!options.targetUserId) {
      throw new Error('adaptive-attacker requires options.targetUserId');
    }

    // Fall back to a seeded deterministic provider when no LLM is supplied.
    const llm = ctx.llm ?? deterministic({ seed: 42 });

    const results = {
      attempts: 0,
      blocked: 0,
      stepUp: 0,
      allowed: 0,
      errors: 0,
      rounds: 0,
      outcome: 'attacker_defeated',
      strategyHistory: [],
    };

    // The history the LLM reasons over. One entry per completed round.
    const history = [];

    emit({
      type: 'milestone',
      message: `Adaptive attacker engaging user ${options.targetUserId} (up to ${options.maxRounds} rounds, provider: ${llm.name ?? 'unknown'})`,
      timestamp: Date.now(),
    });

    for (let round = 1; round <= options.maxRounds; round++) {
      if (signal.aborted) break;

      let parameters;
      let reasoning;

      if (round === 1) {
        // Hardcoded baseline: residential-looking IP, common browser UA.
        parameters = {
          ip: options.baselineIp,
          deviceFingerprint: null, // let the payload builder generate one
          userAgent:
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          delayMs: options.delayMs,
        };
        reasoning = 'Baseline attempt: residential-looking IP with a common browser user agent.';
      } else {
        // Ask the LLM what to change based on everything so far.
        let strategy;
        try {
          strategy = await llm.generateStrategy({
            scenarioId: 'adaptive-attacker',
            history,
            round,
            maxRound: options.maxRounds,
          });
        } catch (err) {
          // Providers shouldn't throw, but guard anyway — never crash the run.
          results.errors++;
          emit({
            type: 'error',
            message: `LLM provider threw on round ${round}: ${err.message}`,
            timestamp: Date.now(),
          });
          strategy = { reasoning: 'Provider error — reusing previous parameters.', parameters };
        }

        parameters = { ...parameters, ...(strategy?.parameters ?? {}) };
        reasoning = strategy?.reasoning ?? '';
      }

      // Emit the adaptation BEFORE sending — this is the demo moment.
      emit({
        type: 'attacker_adapts',
        round,
        reasoning,
        parameters,
        timestamp: Date.now(),
      });
      results.strategyHistory.push({ round, reasoning, parameters });

      const payload = buildLoginPayload(options.targetUserId, {
        ip_address: parameters.ip,
        user_agent: parameters.userAgent,
        ...(parameters.deviceFingerprint
          ? { device_fingerprint: parameters.deviceFingerprint }
          : {}),
      });

      const t0 = Date.now();
      emit({ type: 'attempt', round, payload, timestamp: t0 });

      let response;
      try {
        response = await target.scoreLogin(payload);
      } catch (err) {
        results.errors++;
        emit({
          type: 'error',
          message: `Round ${round} attempt failed: ${err.message}`,
          timestamp: Date.now(),
        });
        results.rounds = round;
        // Record the failure in history so the LLM can react to it.
        history.push({ round, parameters, decision: 'ERROR', reasons: [] });
        continue;
      }

      const latencyMs = Date.now() - t0;
      emit({ type: 'response', round, response, latencyMs, timestamp: Date.now() });

      results.attempts++;
      results.rounds = round;
      const decision = response?.decision ?? 'ERROR';
      const reasons = Array.isArray(response?.reasons) ? response.reasons : [];

      if (decision === 'BLOCK') results.blocked++;
      else if (decision === 'STEP_UP') results.stepUp++;
      else if (decision === 'ALLOW') results.allowed++;
      else results.errors++;

      history.push({ round, parameters, decision, reasons });

      if (decision === 'ALLOW') {
        results.outcome = 'attacker_succeeded';
        emit({
          type: 'milestone',
          message: `Round ${round}: ALLOW — attacker found a gap and succeeded`,
          timestamp: Date.now(),
        });
        break;
      }

      // Pace the next round by the sim's own knob (options.delayMs), not the
      // strategy's delayMs. The attacker's chosen delay is a real adaptation —
      // it's recorded in the attacker_adapts event and strategyHistory — but
      // enacting a 5–15s velocity-evasion wait per round would make a run take
      // minutes for no benefit. This is a simulator; the decision is what's
      // interesting, not the wall-clock wait.
      try {
        await sleep(options.delayMs, signal);
      } catch {
        break; // aborted
      }
    }

    if (results.outcome !== 'attacker_succeeded') {
      emit({
        type: 'milestone',
        message: `Attacker defeated after ${results.rounds} round(s) — no ALLOW reached`,
        timestamp: Date.now(),
      });
    }

    return {
      attempts: results.attempts,
      blocked: results.blocked,
      stepUp: results.stepUp,
      allowed: results.allowed,
      errors: results.errors,
      rounds: results.rounds,
      outcome: results.outcome,
      strategyHistory: results.strategyHistory,
    };
  },
};
