/**
 * Example: Run an account drain scenario against the local mock target.
 *
 * Prerequisite: Start the mock target first
 *   npm run example:mock-target
 *
 * Then in another terminal:
 *   npm run example:drain
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

console.log('\n=== Account drain simulation ===\n');

const report = await run('account-drain', {
  target,
  options: {
    targetUserId: 'victim_user_002',
    withdrawalCount: 5,
    amountKobo: 4500000,
    delayBetweenWithdrawalsMs: 500,
    postLoginPauseMs: 1000,
  },
  onEvent: (e) => {
    if (e.type === 'milestone') {
      console.log(`\n  ▶ ${e.message}`);
    }
    if (e.type === 'response') {
      const reasons = (e.response.reasons ?? []).map((r) => r.code).join(', ') || '—';
      console.log(
        `    → ${e.response.decision.padEnd(7)}  score ${e.response.riskScore?.toFixed(2) ?? '?'}  ${reasons}`
      );
    }
  },
});

console.log('\n=== Report ===\n');
console.log(`  Login decision:     ${report.loginDecision}`);
console.log(`  Attempts total:     ${report.attempts}`);
console.log(`  Withdrawals tried:  ${report.withdrawalDecisions.length}`);
console.log(`  Attacker succeeded: ${report.attackerSucceeded ? 'YES (account drained!)' : 'no'}`);
console.log();
