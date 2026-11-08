/**
 * Compiled, never run: `npm run test:types` type-checks this file against the
 * declarations in types/, imported by package name exactly as a TypeScript
 * user would. It fails if an `exports` entry stops resolving to its types, or
 * if a README example stops type-checking.
 */

import { run, runSuite, listScenarios, type ScenarioReport } from 'fraud-sim';
import { httpAdapter, mockAdapter, loggingAdapter } from 'fraud-sim/adapters';
import { deterministic, openai, anthropic, deepseek } from 'fraud-sim/llm';
import { sseStream } from 'fraud-sim/streaming';
import { withSeed, DeterministicRng } from 'fraud-sim/utils';
import { generateReport, formatMoney } from 'fraud-sim/reporting';

export async function readmeExamples(): Promise<void> {
  const target = httpAdapter({
    baseUrl: 'https://api.your-fraud-system.com',
    headers: { Authorization: `Bearer ${process.env.API_KEY}` },
  });

  const report: ScenarioReport = await run('credential-stuffing', {
    options: { targetUserIds: ['user_001', 'user_002'], attackerCount: 20 },
    target,
    onEvent: (event: unknown) => console.log(event),
  });
  console.log(report.blockRate);

  await run('account-drain', { target, locale: 'GB', options: { targetUserId: 'u1' } });

  for (const llm of [
    anthropic({ apiKey: 'sk-ant', model: 'claude-sonnet-5-5' }),
    openai({ apiKey: 'sk' }),
    deepseek({ apiKey: 'sk', thinking: true, reasoningEffort: 'low' }),
    deterministic({ seed: 42 }),
  ]) {
    await run('adaptive-attacker', {
      options: { targetUserId: 'test_user_001', maxRounds: 10 },
      target: mockAdapter(),
      llm,
      seed: 42,
    });
  }

  const suite = await runSuite({
    name: 'nightly',
    target: loggingAdapter(mockAdapter()),
    scenarios: [{ id: 'credential-stuffing', options: { targetUserIds: ['u1'] } }],
  });
  console.log(generateReport(suite), formatMoney, listScenarios(), sseStream, withSeed, DeterministicRng);
}
