/**
 * Example: Run credential stuffing against a local mock target.
 *
 * Prerequisite: Start the mock target first
 *   npm run example:mock-target
 *
 * Then in another terminal:
 *   npm run example:basic
 */

import { run } from '../../src/index.js';
import { httpAdapter } from '../../src/adapters/http.js';

const target = httpAdapter({
  baseUrl: process.env.TARGET_URL ?? 'http://localhost:4000',
  endpoints: {
    scoreLogin: '/score/login',
    scoreWithdrawal: '/score/withdrawal',
  },
});

const events = [];

console.log('\n=== Credential stuffing simulation ===\n');

const report = await run('credential-stuffing', {
  target,
  options: {
    targetUserId: 'victim_user_001',
    attackerCount: 10,
    attemptsPerIp: 3,
    delayMs: 50,
  },
  onEvent: (e) => {
    events.push(e);
    if (e.type === 'response') {
      const decisionColor = {
        BLOCK: '\x1b[31m',    // red
        STEP_UP: '\x1b[33m',  // yellow
        ALLOW: '\x1b[32m',    // green
        ERROR: '\x1b[35m',    // magenta
      };
      const color = decisionColor[e.response.decision] ?? '';
      const reset = '\x1b[0m';
      const reasons = (e.response.reasons ?? []).map((r) => r.code).join(', ') || '—';
      console.log(
        `  attempt ${String(e.round).padStart(3)}  ${color}${e.response.decision.padEnd(7)}${reset}  score ${e.response.riskScore?.toFixed(2) ?? '?'}  ${reasons}`
      );
    }
  },
});

console.log('\n=== Report ===\n');
console.log(`  Attempts:    ${report.attempts}`);
console.log(`  Blocked:     ${report.blocked}`);
console.log(`  Step-up:     ${report.stepUp}`);
console.log(`  Allowed:     ${report.allowed}`);
console.log(`  Block rate:  ${(report.blockRate * 100).toFixed(1)}%`);
console.log(`  Duration:    ${report.durationMs}ms`);
console.log();
