import { formatMoney } from './money.js';

/**
 * Turning raw run data into the things a report needs to say.
 *
 * Kept separate from rendering so every output format — HTML, JUnit, JSON —
 * agrees on the numbers. A format that computed its own totals would eventually
 * disagree with another one, and a report that contradicts itself is worse than
 * no report.
 */

/** Accepts a single ScenarioReport, an array of them, or a SuiteReport. */
export function normaliseInput(result) {
  if (Array.isArray(result)) return { name: 'fraud-sim run', reports: result };
  if (result?.scenarioReports) {
    return { name: result.suiteName ?? 'fraud-sim suite', reports: result.scenarioReports };
  }
  if (result?.scenarioId) return { name: result.scenarioId, reports: [result] };
  throw new Error(
    'generateReport expects a scenario report, an array of them, or the result of runSuite().'
  );
}

/** True for traffic a defence should let through — see legitimate-users. */
export function isLegitimate(report) {
  return report?.traffic === 'legitimate';
}

/**
 * Totals across every attack scenario, using the same denominator rule as a
 * single run: rates are over attempts that actually received a decision.
 *
 * Legitimate traffic is kept out of these figures and summarised under
 * `legitimate` instead. A blocked customer added to the block rate would make
 * a defence look better the more good customers it refused.
 */
export function totalsFor(reports) {
  const attacks = reports.filter((r) => !isLegitimate(r));
  const t = { attempts: 0, blocked: 0, stepUp: 0, allowed: 0, errors: 0 };
  for (const r of attacks) {
    t.attempts += r.attempts ?? 0;
    t.blocked += r.blocked ?? 0;
    t.stepUp += r.stepUp ?? 0;
    t.allowed += r.allowed ?? 0;
    t.errors += r.errors ?? 0;
  }

  const scoredAttempts = Math.max(0, t.attempts - t.errors);

  return {
    ...t,
    scoredAttempts,
    blockRate: scoredAttempts > 0 ? t.blocked / scoredAttempts : 0,
    stepUpRate: scoredAttempts > 0 ? t.stepUp / scoredAttempts : 0,
    allowRate: scoredAttempts > 0 ? t.allowed / scoredAttempts : 0,
    errorRate: t.attempts > 0 ? t.errors / t.attempts : 0,
    scenarios: attacks.length,
    attacksSucceeded: attacks.filter((r) => r.attackerSucceeded === true).length,
    estimatedLossMinor: attacks.reduce((a, r) => a + lossOf(r), 0),
    // Retained for callers written against the naira-specific name.
    estimatedLossKobo: attacks.reduce((a, r) => a + lossOf(r), 0),
    legitimate: legitimateTotalsFor(reports),
  };
}

/**
 * What the defence cost ordinary customers, or `null` when the run included
 * no legitimate traffic — absent is different from zero, and a report should
 * never claim "no false positives" for a run that could not have seen any.
 */
export function legitimateTotalsFor(reports) {
  const legit = reports.filter(isLegitimate);
  if (legit.length === 0) return null;

  const t = { attempts: 0, blocked: 0, stepUp: 0, allowed: 0, errors: 0 };
  let customers = 0;
  let customersBlocked = 0;
  let valueBlockedMinor = 0;
  for (const r of legit) {
    t.attempts += r.attempts ?? 0;
    t.blocked += r.blocked ?? 0;
    t.stepUp += r.stepUp ?? 0;
    t.allowed += r.allowed ?? 0;
    t.errors += r.errors ?? 0;
    customers += r.customers ?? 0;
    customersBlocked += r.customersBlocked ?? 0;
    valueBlockedMinor += r.valueBlockedMinor ?? 0;
  }

  const scoredAttempts = Math.max(0, t.attempts - t.errors);

  return {
    ...t,
    scoredAttempts,
    falsePositiveRate: scoredAttempts > 0 ? t.blocked / scoredAttempts : 0,
    frictionRate: scoredAttempts > 0 ? (t.blocked + t.stepUp) / scoredAttempts : 0,
    errorRate: t.attempts > 0 ? t.errors / t.attempts : 0,
    customers,
    customersBlocked,
    valueBlockedMinor,
  };
}

/** Reason codes across the whole run, most frequent first. */
export function reasonFrequency(reports) {
  const counts = new Map();
  for (const r of reports) {
    for (const [code, n] of Object.entries(r.reasonCounts ?? {})) {
      counts.set(code, (counts.get(code) ?? 0) + n);
    }
  }
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/** Latency across the whole run — merged samples, not an average of averages. */
export function latencyFor(reports) {
  const present = reports.map((r) => r.latency).filter((l) => l && l.count > 0);
  if (present.length === 0) return { count: 0, p50: null, p95: null, p99: null, max: null };

  // Per-scenario percentiles cannot be re-averaged into a suite percentile, so
  // report the range honestly: worst observed p95, and the true max.
  return {
    count: present.reduce((a, l) => a + l.count, 0),
    p50: Math.max(...present.map((l) => l.p50)),
    p95: Math.max(...present.map((l) => l.p95)),
    p99: Math.max(...present.map((l) => l.p99)),
    max: Math.max(...present.map((l) => l.max)),
    approximate: present.length > 1,
  };
}

/**
 * Classify what a scenario's run actually means, which is not the same as its
 * block rate. Order matters: reaching money outranks everything, and a result
 * we cannot trust must never be reported as a pass.
 */
/**
 * A scenario's extracted value, in the currency's minor unit.
 *
 * Amounts are minor-unit integers throughout — kobo, cents, the same thing
 * structurally — so nothing here is currency-specific. `estimatedLossKobo`
 * is the original naira-flavoured name, kept working.
 */
export function lossOf(report) {
  return report?.estimatedLossMinor ?? report?.estimatedLossKobo ?? 0;
}

export function outcomeFor(report) {
  // Legitimate traffic reads the other way round: a block is the failure.
  if (isLegitimate(report)) {
    if (report.errorRate > 0.05) {
      return { kind: 'unreliable', label: 'Run unreliable', severity: 'unknown' };
    }
    if (report.blocked > 0) {
      return { kind: 'false-positives', label: 'Customers blocked', severity: 'high' };
    }
    if (report.stepUp > 0) {
      return { kind: 'friction', label: 'Challenged, none blocked', severity: 'ok' };
    }
    return { kind: 'clean', label: 'No friction', severity: 'ok' };
  }

  if (lossOf(report) > 0) {
    return { kind: 'loss', label: 'Value extracted', severity: 'critical' };
  }
  if (report.attackerSucceeded === true) {
    return { kind: 'succeeded', label: 'Attack succeeded', severity: 'critical' };
  }
  if (report.errorRate > 0.05) {
    return { kind: 'unreliable', label: 'Run unreliable', severity: 'unknown' };
  }
  // A scenario where nothing was refused is a finding whatever else is true of
  // it — reporting that as merely "timing-dependent" buries the headline.
  if (report.blocked === 0 && report.attempts > 0) {
    return { kind: 'through', label: 'Never blocked', severity: 'high' };
  }
  if (report.simulatedTime) {
    return { kind: 'caveat', label: 'Timing-dependent', severity: 'caveat' };
  }
  return { kind: 'held', label: 'Contained', severity: 'ok' };
}

/**
 * The findings list, worst first.
 *
 * Deliberately conservative: it reports what the data supports and does not
 * guess at causes. A generated finding that speculates is a finding a reader
 * will eventually catch being wrong.
 */
export function findingsFor(reports, options = {}) {
  const money = (minor) => formatMoney(minor, options);
  const findings = [];

  for (const r of reports) {
    const outcome = outcomeFor(r);

    if (outcome.kind === 'false-positives') {
      const stats = [
        ['customer events', r.scoredAttempts],
        ['blocked', r.blocked],
        ['false-positive rate', pct(r.falsePositiveRate ?? r.blockRate)],
        ['customers refused', `${r.customersBlocked ?? '—'} of ${r.customers ?? '—'}`],
      ];
      if (r.valueBlockedMinor > 0) stats.push(['payments refused', money(r.valueBlockedMinor)]);
      for (const [stage, row] of Object.entries(r.byStage ?? {})) {
        if (row.blocked > 0) stats.push([`blocked on ${stage}`, `${row.blocked} of ${row.events}`]);
      }
      const reasons = Object.keys(r.falsePositiveReasons ?? {}).slice(0, 3);
      if (reasons.length) stats.push(['top reasons', reasons.join(', ')]);

      // Customer sessions are days apart on the event clock but arrive within
      // seconds. A windowed rule that counts arrivals sees a burst, so a
      // velocity block here may be the compression, not the customer.
      const windowed = Object.keys(r.falsePositiveReasons ?? {}).filter((code) =>
        /VELOCITY|RATE|FREQUENCY|BURST/i.test(code)
      );
      const caveat =
        r.simulatedTime && windowed.length
          ? ` Caveat: ${windowed.join(', ')} count events in a time window, and this traffic ` +
            `spans ${r.simulatedSpan ?? 'days'} of event time delivered in seconds. If the target ` +
            'windows on arrival time rather than the event timestamp, those blocks are the ' +
            "simulator's compression, not customer behaviour."
          : '';
      if (caveat) stats.push(['simulated span', r.simulatedSpan ?? '—']);

      findings.push({
        severity: 'high',
        scenario: r.scenarioId,
        title: 'Legitimate customers were blocked',
        detail:
          `${r.blocked} of ${r.scoredAttempts} ordinary customer events were refused ` +
          `(${pct(r.falsePositiveRate ?? r.blockRate)}). Every one is a real customer locked ` +
          'out of their own account — the cost a block rate never shows.' +
          caveat,
        stats,
      });
      continue;
    }

    if (outcome.kind === 'loss') {
      findings.push({
        severity: 'critical',
        scenario: r.scenarioId,
        title: 'The attack reached money',
        detail:
          `${money(lossOf(r))} was extracted despite a ` +
          `${pct(r.blockRate)} block rate. A block rate averages over every event ` +
          'an attacker generates, and attackers generate many cheap events on the ' +
          'way to a few expensive ones.',
        stats: lossStats(r, money),
      });
    } else if (outcome.kind === 'succeeded') {
      findings.push({
        severity: 'critical',
        scenario: r.scenarioId,
        title: 'The attack completed',
        detail: 'The scenario reached its objective without being stopped.',
        stats: lossStats(r, money),
      });
    } else if (outcome.kind === 'through') {
      findings.push({
        severity: 'high',
        scenario: r.scenarioId,
        title: 'Nothing was ever blocked',
        detail:
          `${r.attempts} event${r.attempts === 1 ? '' : 's'} scored, none refused` +
          (r.stepUp > 0 ? ` — ${r.stepUp} challenged, the rest allowed.` : '.'),
        stats: [
          ['events', r.attempts],
          ['blocked', 0],
          ['challenged', r.stepUp],
          ['allowed', r.allowed],
        ],
      });
    } else if (outcome.kind === 'unreliable') {
      findings.push({
        severity: 'high',
        scenario: r.scenarioId,
        title: 'This run did not measure the defence',
        detail:
          `${pct(r.errorRate)} of attempts never received a decision. A target that ` +
          'is rate limiting or failing is not a target that is defending; treat this ' +
          'scenario as not run.',
        stats: [
          ['attempts', r.attempts],
          ['scored', r.scoredAttempts],
          ['errors', r.errors],
        ],
      });
    } else if (outcome.kind === 'caveat') {
      findings.push({
        severity: 'medium',
        scenario: r.scenarioId,
        title: 'Result depends on which clock the target uses',
        detail:
          'This scenario spaces its events by advancing the event timestamp rather ' +
          'than sleeping. If the target derives its velocity windows from server ' +
          'arrival time, it saw a burst and this figure says nothing about the ' +
          'attack the scenario describes.',
        stats: [
          ['simulated span', r.simulatedSpan ?? '—'],
          ['block rate', pct(r.blockRate)],
        ],
      });
    }
  }

  const rank = { critical: 0, high: 1, medium: 2 };
  return findings.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

function lossStats(r, money) {
  const stats = [
    ['events', r.attempts],
    ['block rate', pct(r.blockRate)],
  ];
  if (lossOf(r)) stats.push(['extracted', money(lossOf(r))]);
  if (r.cardsValidated != null) stats.push(['cards validated', r.cardsValidated]);
  if (r.escalationsAllowed != null) stats.push(['charges allowed', r.escalationsAllowed]);
  if (r.bonusesClaimed != null) stats.push(['bonuses paid', r.bonusesClaimed]);
  if (r.firstBlockedAtAccount != null) stats.push(['first block at account', r.firstBlockedAtAccount]);
  if (r.blockedAtStage != null) stats.push(['first pushback', r.blockedAtStage]);
  return stats;
}

export function pct(n) {
  if (!Number.isFinite(n)) return '—';
  return `${(n * 100).toFixed(1)}%`;
}

/** @deprecated Use `formatMoney` from ./money.js — kept for compatibility. */
export function fmtNaira(kobo) {
  return formatMoney(kobo, { currency: 'NGN' });
}

export function fmtMs(ms) {
  return Number.isFinite(ms) ? `${ms}ms` : '—';
}
