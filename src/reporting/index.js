/**
 * Report generation — `fraud-sim/reporting`.
 *
 * @example
 *   import { runSuite } from 'fraud-sim';
 *   import { generateReport } from 'fraud-sim/reporting';
 *   import { writeFileSync } from 'node:fs';
 *
 *   const result = await runSuite({ name: 'nightly', target, scenarios, seed: 42 });
 *   writeFileSync('report.html', generateReport(result, { format: 'html' }));
 */

import { formatMoney } from './money.js';
import { renderHtml } from './html.js';
import { renderJUnit } from './junit.js';
import {
  normaliseInput,
  totalsFor,
  reasonFrequency,
  latencyFor,
  findingsFor,
  outcomeFor,
  isLegitimate,
  pct,
} from './aggregate.js';

const FORMATS = ['html', 'junit', 'json', 'text'];

/**
 * Render a run as a shareable report.
 *
 * Synchronous and pure — it returns a string and touches no filesystem, so the
 * caller decides where output goes and nothing surprising happens on import.
 *
 * @param {object} result - A ScenarioReport, an array of them, or a SuiteReport.
 * @param {object} [options]
 * @param {'html'|'junit'|'json'|'text'} [options.format='html']
 * @param {string} [options.title]
 * @param {string} [options.targetName]
 * @param {string} [options.version]
 * @param {number} [options.failUnder] - Block rate below which a scenario is a
 *   CI failure. Used by the junit and text formats.
 * @param {number} [options.maxFalsePositiveRate] - Share of legitimate
 *   customer events that may be blocked before the run fails. Used by the
 *   junit and text formats.
 * @param {string} [options.currency='NGN'] - Display currency. Amounts are
 *   minor-unit integers, so this changes presentation only.
 * @param {string} [options.locale] - Defaults to a locale for the currency.
 * @returns {string}
 */
export function generateReport(result, options = {}) {
  const format = options.format ?? 'html';

  if (!FORMATS.includes(format)) {
    throw new Error(`Unknown report format: "${format}". Expected one of: ${FORMATS.join(', ')}.`);
  }

  if (format === 'html') return renderHtml(result, options);
  if (format === 'junit') return renderJUnit(result, options);
  if (format === 'json') return JSON.stringify(summarise(result, options), null, 2);
  return renderText(result, options);
}

/**
 * The structured summary behind every format. Useful on its own when you want
 * to assert on a run in CI without parsing a rendered document.
 */
export function summarise(result, options = {}) {
  const { name, reports } = normaliseInput(result);

  return {
    name: options.title ?? name,
    generatedAt: (options.now ?? new Date()).toISOString(),
    totals: totalsFor(reports),
    latency: latencyFor(reports),
    findings: findingsFor(reports, options),
    reasonCounts: Object.fromEntries(reasonFrequency(reports)),
    scenarios: reports.map((r) => ({
      scenarioId: r.scenarioId,
      traffic: r.traffic ?? 'attack',
      attempts: r.attempts,
      scoredAttempts: r.scoredAttempts,
      blocked: r.blocked,
      stepUp: r.stepUp,
      allowed: r.allowed,
      errors: r.errors,
      blockRate: r.blockRate,
      errorRate: r.errorRate,
      seed: r.seed ?? null,
      latency: r.latency ?? null,
      simulatedTime: r.simulatedTime ?? false,
      attackerSucceeded: r.attackerSucceeded ?? null,
      estimatedLossKobo: r.estimatedLossKobo ?? null,
      ...(isLegitimate(r)
        ? {
            falsePositiveRate: r.falsePositiveRate ?? r.blockRate,
            frictionRate: r.frictionRate ?? null,
            customers: r.customers ?? null,
            customersBlocked: r.customersBlocked ?? null,
            valueBlockedMinor: r.valueBlockedMinor ?? 0,
            byStage: r.byStage ?? null,
          }
        : {}),
      outcome: outcomeFor(r),
    })),
  };
}

/** A terminal summary — what the CLI prints when no report file is asked for. */
function renderText(result, options = {}) {
  const { reports: all } = normaliseInput(result);
  const reports = all.filter((r) => !isLegitimate(r));
  const customers = all.filter(isLegitimate);
  const totals = totalsFor(all);
  const findings = findingsFor(all, options);

  const pad = (s, n) => String(s).padEnd(n);
  const rpad = (s, n) => String(s).padStart(n);
  const width = Math.max(20, ...all.map((r) => String(r.scenarioId).length));

  const lines = [];
  lines.push('');
  lines.push(
    `  ${pad('SCENARIO', width)}  ${rpad('EVENTS', 6)}  ${rpad('BLOCK', 6)}  ${rpad('CHALL', 6)}  ${rpad('ALLOW', 6)}  ${rpad('RATE', 7)}  OUTCOME`
  );
  lines.push(`  ${'-'.repeat(width + 48)}`);

  for (const r of reports) {
    const o = outcomeFor(r);
    lines.push(
      `  ${pad(r.scenarioId, width)}  ${rpad(r.attempts, 6)}  ${rpad(r.blocked, 6)}  ` +
        `${rpad(r.stepUp, 6)}  ${rpad(r.allowed, 6)}  ${rpad((r.blockRate * 100).toFixed(1) + '%', 7)}  ${o.label}`
    );
  }

  lines.push('');
  lines.push(
    `  TOTAL  ${totals.attempts} events · ${totals.scoredAttempts} scored · ` +
      `${(totals.blockRate * 100).toFixed(1)}% blocked · ${totals.errors} errors`
  );

  if (totals.estimatedLossMinor > 0) {
    lines.push(`  LOSS   ${formatMoney(totals.estimatedLossMinor, options)} extracted`);
  }

  // The other half of the measurement, in its own table: here a block is the
  // bad outcome, so it must not sit in a column read as "higher is better".
  if (customers.length) {
    const legit = totals.legitimate;
    lines.push('');
    lines.push(
      `  ${pad('LEGITIMATE TRAFFIC', width)}  ${rpad('EVENTS', 6)}  ${rpad('BLOCK', 6)}  ${rpad('CHALL', 6)}  ${rpad('ALLOW', 6)}  ${rpad('FALSE+', 7)}  OUTCOME`
    );
    lines.push(`  ${'-'.repeat(width + 48)}`);
    for (const r of customers) {
      lines.push(
        `  ${pad(r.scenarioId, width)}  ${rpad(r.attempts, 6)}  ${rpad(r.blocked, 6)}  ` +
          `${rpad(r.stepUp, 6)}  ${rpad(r.allowed, 6)}  ${rpad(pct(r.falsePositiveRate ?? r.blockRate), 7)}  ${outcomeFor(r).label}`
      );
    }
    lines.push('');
    lines.push(
      `  CUSTOMERS  ${legit.scoredAttempts} events · ${pct(legit.falsePositiveRate)} blocked (false positives) · ` +
        `${pct(legit.frictionRate)} challenged or blocked · ${legit.customersBlocked} of ${legit.customers} customers refused`
    );
    if (legit.valueBlockedMinor > 0) {
      lines.push(`  REFUSED    ${formatMoney(legit.valueBlockedMinor, options)} of customers' own payments`);
    }
  }

  if (findings.length) {
    lines.push('');
    lines.push(`  FINDINGS (${findings.length})`);
    for (const f of findings) {
      lines.push(`    [${f.severity.toUpperCase()}] ${f.scenario} — ${f.title}`);
    }
  }

  if (Number.isFinite(options.maxFalsePositiveRate)) {
    lines.push('');
    const legit = totals.legitimate;
    const ceiling = pct(options.maxFalsePositiveRate);
    if (!legit) {
      lines.push('  GATE   FP n/a — no legitimate traffic in this run (add legitimate-users)');
    } else if (legit.errorRate > 0.05) {
      lines.push('  GATE   FP n/a — too many customer events went unscored to judge');
    } else {
      lines.push(
        legit.falsePositiveRate > options.maxFalsePositiveRate
          ? `  GATE   FAIL — false-positive rate ${pct(legit.falsePositiveRate)} is above the ${ceiling} ceiling`
          : `  GATE   PASS — false-positive rate ${pct(legit.falsePositiveRate)} is within the ${ceiling} ceiling`
      );
    }
  }

  if (Number.isFinite(options.failUnder)) {
    lines.push('');
    // A gate verdict on an unmeasurable run is noise at best and misleading at
    // worst — the block rate is low because nothing was scored, not because the
    // defence is weak.
    if (totals.errorRate > 0.05) {
      lines.push('  GATE   n/a — too many attempts went unscored to judge the defence');
      lines.push('');
      return lines.join('\n');
    }

    const floor = `${(options.failUnder * 100).toFixed(0)}%`;

    if (options.failUnderScope === 'scenario') {
      const failing = reports.filter((r) => r.blockRate < options.failUnder);
      lines.push(
        failing.length
          ? `  GATE   FAIL — ${failing.length} scenario(s) below ${floor}: ${failing.map((r) => r.scenarioId).join(', ')}`
          : `  GATE   PASS — every scenario at or above ${floor}`
      );
    } else {
      const rate = `${(totals.blockRate * 100).toFixed(1)}%`;
      lines.push(
        totals.blockRate < options.failUnder
          ? `  GATE   FAIL — overall block rate ${rate} is below ${floor}`
          : `  GATE   PASS — overall block rate ${rate} meets the ${floor} floor`
      );
    }
  }

  lines.push('');
  return lines.join('\n');
}

export { renderHtml, renderJUnit };
export { formatMoney, currencySymbol } from './money.js';
export {
  normaliseInput,
  totalsFor,
  legitimateTotalsFor,
  isLegitimate,
  reasonFrequency,
  latencyFor,
  findingsFor,
  outcomeFor,
} from './aggregate.js';
