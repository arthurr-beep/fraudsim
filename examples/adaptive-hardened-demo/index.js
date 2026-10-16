/**
 * The adaptation demo: the same attacker against two different defences.
 *
 * Run the hardened target first:
 *   npm run example:hardened-target      (terminal 1, port 4001)
 *   npm run example:mock-target          (terminal 2, port 4000)
 *   npm run example:adaptive-hardened    (terminal 3)
 *
 * Against the simple target the attacker wins on move one and never adapts —
 * which tells you about that target's cold-start gap and nothing at all about
 * the attacker. Against the hardened target it has to work, and the round log
 * shows what it changed and why.
 */

import { run } from '../../src/index.js';
import { httpAdapter } from '../../src/adapters/http.js';

const SIMPLE = 'http://localhost:4000';
const HARDENED = 'http://localhost:4001';
const SEED = 7;

const COLOUR = { BLOCK: '\x1b[31m', STEP_UP: '\x1b[33m', ALLOW: '\x1b[32m', ERROR: '\x1b[35m' };
const RESET = '\x1b[0m';
const DIM = '\x1b[2m';

async function attack(label, baseUrl) {
  const target = httpAdapter({
    baseUrl,
    endpoints: { scoreLogin: '/score/login' },
  });

  // Clear the target's memory so each run starts from the same place.
  try {
    await fetch(`${baseUrl}/reset`, { method: 'POST' });
  } catch {
    console.error(`  Could not reach ${baseUrl} — is that target running?`);
    return null;
  }

  console.log(`\n${'═'.repeat(72)}`);
  console.log(`  ${label}  ${DIM}${baseUrl}${RESET}`);
  console.log('═'.repeat(72));

  let pendingReasoning = '';

  const report = await run('adaptive-attacker', {
    target,
    options: { targetUserId: 'victim_001', maxRounds: 8, delayMs: 120 },
    seed: SEED,
    onEvent: (event) => {
      if (event.type === 'attacker_adapts') {
        pendingReasoning = event.reasoning;
      } else if (event.type === 'response') {
        const decision = event.response?.decision ?? 'ERROR';
        const colour = COLOUR[decision] ?? '';
        const codes = (event.response?.reasons ?? []).map((r) => r.code).join(', ') || '—';
        const score = event.response?.riskScore;

        console.log(
          `\n  round ${String(event.round).padStart(2)}  ` +
            `${colour}${decision.padEnd(8)}${RESET}` +
            `${DIM}risk ${score != null ? score.toFixed(2) : '—'}${RESET}  ${codes}`
        );
        console.log(`          ${DIM}↳ ${pendingReasoning}${RESET}`);
      }
    },
  });

  const verdict =
    report.outcome === 'attacker_succeeded'
      ? `${COLOUR.ALLOW}attacker succeeded${RESET} on round ${report.attempts}`
      : `${COLOUR.BLOCK}attacker defeated${RESET} after ${report.attempts} rounds`;

  console.log(`\n  ${verdict}`);
  console.log(
    `  ${DIM}blocked ${report.blocked} · challenged ${report.stepUp} · allowed ${report.allowed}${RESET}`
  );

  return report;
}

const simple = await attack('SIMPLE TARGET', SIMPLE);
const hardened = await attack('HARDENED TARGET', HARDENED);

if (simple && hardened) {
  console.log(`\n${'═'.repeat(72)}`);
  console.log('  WHAT CHANGED');
  console.log('═'.repeat(72));
  console.log(`
  Same scenario, same seed (${SEED}), two defences.

  Simple target    ${simple.attempts} round(s) — ${simple.outcome}
  Hardened target  ${hardened.attempts} round(s) — ${hardened.outcome}

  The simple target allows an unrecognised device outright, so the attacker's
  opening move works and no adaptation is ever needed or visible. The hardened
  target only ever challenges an unrecognised device, so rotation can win back
  a step-up but never an allow.

  The gap the hardened target leaves: a device that was challenged is
  remembered as seen, not as bad. An attacker that reuses it from a clean IP is
  allowed through. The deterministic provider never tries that — it rotates its
  fingerprint every round. Point a real LLM at it with --llm and see whether it
  finds what the scripted attacker cannot.
`);
}
