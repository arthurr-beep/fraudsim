/**
 * JUnit XML renderer — for CI systems that already know how to read it.
 *
 * The mapping from a simulation to a test result needs stating, because the
 * obvious one is wrong. A scenario is not "failed" when the attack was blocked;
 * it is failed when the *defence* was. So:
 *
 *   - failure  → the attack reached its objective, or nothing was ever blocked,
 *                or the block rate fell under `failUnder`.
 *   - error    → the run did not measure anything (the target was erroring),
 *                which is distinct from the defence being weak.
 *   - skipped  → the scenario ran but its result depends on an assumption the
 *                run cannot verify, e.g. a simulated clock against a target
 *                that timestamps on arrival.
 *   - passed   → the attack was contained.
 *
 * Legitimate traffic inverts the first rule. Its failure is a blocked
 * customer: any block by default, or a false-positive rate above
 * `maxFalsePositiveRate` when one is set. It is never held to `failUnder` —
 * a high block rate on good customers is the failure, not the goal.
 *
 * Reporting an unmeasurable run as a pass is the failure mode this mapping
 * exists to avoid: a green pipeline should never be achievable by breaking the
 * target.
 */

import { normaliseInput, totalsFor, outcomeFor, lossOf, pct, isLegitimate } from './aggregate.js';
import { formatMoney } from './money.js';

const XML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => XML_ESCAPES[c]);
}

/**
 * @param {object} result - A ScenarioReport, an array of them, or a SuiteReport.
 * @param {object} [options]
 * @param {number} [options.failUnder] - Minimum acceptable block rate per scenario.
 * @param {number} [options.maxFalsePositiveRate] - Maximum acceptable share of
 *   legitimate customer events blocked.
 * @param {string} [options.suiteName]
 */
export function renderJUnit(result, options = {}) {
  const { name, reports } = normaliseInput(result);
  const suiteName = options.suiteName ?? name ?? 'fraud-sim';
  const totals = totalsFor(reports);
  const durationSec = (reports.reduce((a, r) => a + (r.durationMs ?? 0), 0) / 1000).toFixed(3);

  const cases = reports.map((r) => renderCase(r, options));
  const failures = cases.filter((c) => c.state === 'failure').length;
  const errors = cases.filter((c) => c.state === 'error').length;
  const skipped = cases.filter((c) => c.state === 'skipped').length;

  return `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="${esc(suiteName)}" tests="${reports.length}" failures="${failures}" errors="${errors}" skipped="${skipped}" time="${durationSec}">
  <testsuite name="${esc(suiteName)}" tests="${reports.length}" failures="${failures}" errors="${errors}" skipped="${skipped}" time="${durationSec}">
    <properties>
      <property name="attempts" value="${totals.attempts}"/>
      <property name="scoredAttempts" value="${totals.scoredAttempts}"/>
      <property name="blockRate" value="${totals.blockRate.toFixed(4)}"/>
      <property name="errorRate" value="${totals.errorRate.toFixed(4)}"/>
      <property name="estimatedLossMinor" value="${totals.estimatedLossMinor}"/>${totals.legitimate ? `
      <property name="falsePositiveRate" value="${totals.legitimate.falsePositiveRate.toFixed(4)}"/>
      <property name="frictionRate" value="${totals.legitimate.frictionRate.toFixed(4)}"/>` : ''}
      <property name="currency" value="${esc(options.currency ?? 'NGN')}"/>
    </properties>
${cases.map((c) => c.xml).join('\n')}
  </testsuite>
</testsuites>
`;
}

function renderCase(r, options) {
  const outcome = outcomeFor(r);
  const time = ((r.durationMs ?? 0) / 1000).toFixed(3);
  const id = esc(r.scenarioId ?? 'scenario');
  const open = `    <testcase name="${id}" classname="fraud-sim.${id}" time="${time}">`;

  const detail = esc(
    [
      `attempts=${r.attempts}`,
      `scored=${r.scoredAttempts}`,
      `blocked=${r.blocked}`,
      `stepUp=${r.stepUp}`,
      `allowed=${r.allowed}`,
      `errors=${r.errors}`,
      `blockRate=${pct(r.blockRate)}`,
      r.seed != null ? `seed=${r.seed}` : null,
      lossOf(r) ? `extracted=${formatMoney(lossOf(r), options)}` : null,
    ]
      .filter(Boolean)
      .join(' ')
  );

  // A run that never measured anything is an error, not a failure — the
  // distinction tells whoever reads the pipeline whether to fix the defence or
  // the environment.
  if (outcome.kind === 'unreliable') {
    return {
      state: 'error',
      xml: `${open}
      <error type="TargetUnreliable" message="${esc(`${pct(r.errorRate)} of attempts never received a decision`)}">${detail}</error>
    </testcase>`,
    };
  }

  if (isLegitimate(r)) {
    const fpr = r.falsePositiveRate ?? r.blockRate;
    const gated = Number.isFinite(options.maxFalsePositiveRate);
    const failed = gated ? fpr > options.maxFalsePositiveRate : r.blocked > 0;
    if (failed) {
      const msg = gated
        ? `false-positive rate ${pct(fpr)} is above the allowed ${pct(options.maxFalsePositiveRate)}`
        : `${r.blocked} legitimate customer event(s) blocked (${pct(fpr)})`;
      return {
        state: 'failure',
        xml: `${open}
      <failure type="FalsePositives" message="${esc(msg)}">${detail}</failure>
    </testcase>`,
      };
    }
    return { state: 'passed', xml: `${open}
      <system-out>${detail}</system-out>
    </testcase>` };
  }

  if (outcome.kind === 'loss' || outcome.kind === 'succeeded') {
    const msg = lossOf(r)
      ? `Attack succeeded — ${formatMoney(lossOf(r), options)} extracted`
      : 'Attack reached its objective';
    return {
      state: 'failure',
      xml: `${open}
      <failure type="AttackSucceeded" message="${esc(msg)}">${detail}</failure>
    </testcase>`,
    };
  }

  if (outcome.kind === 'through') {
    return {
      state: 'failure',
      xml: `${open}
      <failure type="NothingBlocked" message="No event in this scenario was blocked">${detail}</failure>
    </testcase>`,
    };
  }

  if (Number.isFinite(options.failUnder) && r.blockRate < options.failUnder) {
    return {
      state: 'failure',
      xml: `${open}
      <failure type="BlockRateBelowThreshold" message="${esc(`block rate ${pct(r.blockRate)} is below the required ${pct(options.failUnder)}`)}">${detail}</failure>
    </testcase>`,
    };
  }

  if (outcome.kind === 'caveat') {
    return {
      state: 'skipped',
      xml: `${open}
      <skipped message="Result depends on the target deriving velocity windows from the event timestamp; not verifiable from this run."/>
      <system-out>${detail}</system-out>
    </testcase>`,
    };
  }

  return { state: 'passed', xml: `${open}
      <system-out>${detail}</system-out>
    </testcase>` };
}
