/**
 * Example: LLM adaptive attacker against a local demo target.
 *
 * Prerequisites:
 *   1. Start the demo target:
 *        node examples/adaptive-attacker-demo/demo-target.js
 *   2. In another terminal, run this:
 *        node examples/adaptive-attacker-demo/index.js
 *
 * By default this uses the deterministic (no-API) provider, so it runs
 * anywhere with no API key and produces the same result every time. To use a
 * real LLM, set one of:
 *   OPENAI_API_KEY=sk-...       node examples/adaptive-attacker-demo/index.js
 *   ANTHROPIC_API_KEY=sk-ant-... node examples/adaptive-attacker-demo/index.js
 */

import { run } from '../../src/index.js';
import { httpAdapter } from '../../src/adapters/http.js';
import { deterministic, openai, anthropic } from '../../src/llm/index.js';

const target = httpAdapter({
  baseUrl: process.env.TARGET_URL ?? 'http://localhost:4100',
  endpoints: { scoreLogin: '/score/login' },
});

// Pick a provider from the environment; fall back to the deterministic one.
let llm;
if (process.env.OPENAI_API_KEY) {
  llm = openai({ apiKey: process.env.OPENAI_API_KEY });
} else if (process.env.ANTHROPIC_API_KEY) {
  llm = anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
} else {
  llm = deterministic({ seed: 42 });
}

const C = {
  block: '\x1b[31m',
  stepUp: '\x1b[33m',
  allow: '\x1b[32m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  reset: '\x1b[0m',
};
const decisionColor = { BLOCK: C.block, STEP_UP: C.stepUp, ALLOW: C.allow };

console.log(`\n=== Adaptive attacker (provider: ${llm.name}) ===\n`);

const report = await run('adaptive-attacker', {
  target,
  llm,
  options: { targetUserId: 'victim_user_001', maxRounds: 8, delayMs: 150 },
  onEvent: (e) => {
    if (e.type === 'attacker_adapts') {
      console.log(`${C.cyan}Round ${e.round}${C.reset}  ${C.dim}${e.reasoning}${C.reset}`);
      console.log(
        `${C.dim}         ip=${e.parameters.ip}  device=${String(e.parameters.deviceFingerprint ?? '(generated)').slice(0, 12)}…${C.reset}`
      );
    } else if (e.type === 'response') {
      const color = decisionColor[e.response.decision] ?? '';
      const reasons = (e.response.reasons ?? []).map((r) => r.code).join(', ') || '—';
      console.log(
        `         → ${color}${e.response.decision.padEnd(7)}${C.reset} score ${e.response.riskScore?.toFixed(2) ?? '?'}  ${reasons}\n`
      );
    }
  },
});

const outcomeColor = report.outcome === 'attacker_succeeded' ? C.block : C.allow;
console.log('=== Report ===\n');
console.log(`  Outcome:   ${outcomeColor}${report.outcome}${C.reset}`);
console.log(`  Rounds:    ${report.rounds}`);
console.log(`  Blocked:   ${report.blocked}   Step-up: ${report.stepUp}   Allowed: ${report.allowed}`);
console.log(`  Duration:  ${report.durationMs}ms\n`);

if (report.outcome === 'attacker_succeeded') {
  console.log(
    `${C.dim}  The attacker found a gap: the target scores each attempt in isolation,`
  );
  console.log(
    `  so once the attacker rotated away from the flagged IP, a fresh login was`
  );
  console.log(`  indistinguishable from a legitimate one.${C.reset}\n`);
}
