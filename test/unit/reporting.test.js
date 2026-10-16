import { test } from 'node:test';
import assert from 'node:assert/strict';

import { generateReport, summarise } from '../../src/reporting/index.js';
import { outcomeFor, totalsFor, latencyFor, findingsFor } from '../../src/reporting/aggregate.js';
import { runSuite, run } from '../../src/index.js';
import { mockAdapter } from '../../src/adapters/mock.js';

const report = (over = {}) => ({
  scenarioId: 'test-scenario',
  scenarioName: 'Test',
  attempts: 10,
  scoredAttempts: 10,
  blocked: 8,
  stepUp: 1,
  allowed: 1,
  errors: 0,
  blockRate: 0.8,
  stepUpRate: 0.1,
  errorRate: 0,
  durationMs: 100,
  latency: { count: 10, min: 1, p50: 3, p95: 8, p99: 9, max: 9 },
  reasonCounts: { NEW_DEVICE: 10, LOGIN_VELOCITY_IP: 4 },
  ...over,
});

// ── outcome classification ──────────────────────────────────────────────

test('reaching money outranks every other outcome', () => {
  const r = report({ estimatedLossKobo: 500000, simulatedTime: true, blocked: 0 });
  assert.equal(outcomeFor(r).kind, 'loss');
});

test('an unmeasurable run is never reported as contained', () => {
  const r = report({ errors: 8, attempts: 10, scoredAttempts: 2, errorRate: 0.8, blockRate: 1 });
  assert.equal(outcomeFor(r).kind, 'unreliable');
});

test('nothing-blocked outranks the timing caveat', () => {
  // Otherwise a scenario where the defence never fired gets filed as a
  // methodology footnote instead of a finding.
  const r = report({ blocked: 0, allowed: 10, blockRate: 0, simulatedTime: true });
  assert.equal(outcomeFor(r).kind, 'through');
});

test('a simulated-time run that did block is flagged as timing-dependent', () => {
  assert.equal(outcomeFor(report({ simulatedTime: true })).kind, 'caveat');
});

test('an ordinary contained run is contained', () => {
  assert.equal(outcomeFor(report()).kind, 'held');
});

// ── aggregation ─────────────────────────────────────────────────────────

test('suite totals exclude unscored attempts from the rates', () => {
  const totals = totalsFor([
    report({ attempts: 10, blocked: 5, stepUp: 0, allowed: 0, errors: 5 }),
    report({ attempts: 10, blocked: 5, stepUp: 0, allowed: 5, errors: 0 }),
  ]);

  assert.equal(totals.attempts, 20);
  assert.equal(totals.scoredAttempts, 15);
  assert.equal(totals.blockRate, 10 / 15);
  assert.equal(totals.errorRate, 5 / 20);
});

test('suite latency reports the worst per-scenario percentile, and says so', () => {
  const l = latencyFor([
    report({ latency: { count: 5, min: 1, p50: 2, p95: 4, p99: 5, max: 5 } }),
    report({ latency: { count: 5, min: 1, p50: 9, p95: 20, p99: 30, max: 40 } }),
  ]);

  assert.equal(l.count, 10);
  assert.equal(l.p95, 20);
  assert.equal(l.max, 40);
  // Percentiles cannot be re-averaged; the flag stops a reader treating this
  // as a merged distribution.
  assert.equal(l.approximate, true);
});

test('findings are ranked worst first', () => {
  const findings = findingsFor([
    report({ scenarioId: 'timing', simulatedTime: true }),
    report({ scenarioId: 'paid', estimatedLossKobo: 100 }),
    report({ scenarioId: 'through', blocked: 0, allowed: 10, blockRate: 0 }),
  ]);

  assert.deepEqual(
    findings.map((f) => f.severity),
    ['critical', 'high', 'medium']
  );
  assert.equal(findings[0].scenario, 'paid');
});

test('a clean run produces no findings', () => {
  assert.deepEqual(findingsFor([report()]), []);
});

// ── formats ─────────────────────────────────────────────────────────────

test('generateReport rejects an unknown format', () => {
  assert.throws(() => generateReport([report()], { format: 'pdf' }), /Unknown report format/);
});

test('generateReport accepts a single report, an array, or a suite result', () => {
  const single = report();
  for (const input of [single, [single], { suiteName: 's', scenarioReports: [single] }]) {
    const html = generateReport(input, { format: 'html' });
    assert.match(html, /<!doctype html>/i);
  }
  assert.throws(() => generateReport({ nonsense: true }), /expects a scenario report/);
});

test('the html report escapes scenario ids and reason codes', () => {
  // Scenario ids come from user-written scenarios and reason codes from the
  // target's own response, so neither is trusted input.
  const html = generateReport(
    [report({ scenarioId: '<img src=x onerror=alert(1)>', reasonCounts: { '<script>': 3 } })],
    { format: 'html' }
  );

  assert.ok(!html.includes('<img src=x'), 'scenario id was not escaped');
  assert.ok(!html.includes('<script>'), 'reason code was not escaped');
  assert.match(html, /&lt;img src=x/);
});

test('the html report is a complete standalone document', () => {
  const html = generateReport([report()], { format: 'html', title: 'My Assessment' });
  assert.match(html, /<!doctype html>/i);
  assert.match(html, /<title>My Assessment<\/title>/);
  assert.match(html, /@media print/);
  assert.match(html, /print-color-adjust: ?exact/);
  assert.ok(html.trimEnd().endsWith('</html>'));
});

test('the html report warns when a run was not seeded', () => {
  const unseeded = generateReport([report()], { format: 'html' });
  assert.match(unseeded, /was not\s+seeded/);

  const seeded = generateReport([report({ seed: 42 })], { format: 'html' });
  assert.ok(!/was not\s+seeded/.test(seeded));
});

test('junit maps a successful attack to a failure, not a pass', () => {
  const xml = generateReport([report({ estimatedLossKobo: 50000, attackerSucceeded: true })], {
    format: 'junit',
  });

  assert.match(xml, /<failure type="AttackSucceeded"/);
  assert.match(xml, /failures="1"/);
});

test('junit maps an unreliable target to an error, not a failure', () => {
  // A pipeline must be able to tell "the defence is weak" from "the target was
  // down" — reporting both as a failure sends people to debug the wrong thing.
  const xml = generateReport(
    [report({ errors: 9, attempts: 10, scoredAttempts: 1, errorRate: 0.9 })],
    { format: 'junit' }
  );

  assert.match(xml, /<error type="TargetUnreliable"/);
  assert.match(xml, /errors="1"/);
  assert.match(xml, /failures="0"/);
});

test('junit marks a timing-dependent result skipped rather than passed', () => {
  const xml = generateReport([report({ simulatedTime: true })], { format: 'junit' });
  assert.match(xml, /<skipped message="Result depends on the target/);
  assert.match(xml, /skipped="1"/);
});

test('junit honours a per-scenario block-rate floor', () => {
  const xml = generateReport([report({ blockRate: 0.5 })], { format: 'junit', failUnder: 0.8 });
  assert.match(xml, /<failure type="BlockRateBelowThreshold"/);
});

test('junit escapes XML metacharacters', () => {
  const xml = generateReport([report({ scenarioId: 'a<b&c"d' })], { format: 'junit' });
  assert.ok(!/name="a<b/.test(xml));
  assert.match(xml, /a&lt;b&amp;c&quot;d/);
});

test('json output carries the structured summary', () => {
  const parsed = JSON.parse(generateReport([report({ seed: 3 })], { format: 'json' }));
  assert.equal(parsed.totals.attempts, 10);
  assert.equal(parsed.scenarios[0].seed, 3);
  assert.equal(parsed.scenarios[0].outcome.kind, 'held');
  assert.ok(parsed.generatedAt);
});

test('text output states the gate scope it is reporting', () => {
  // Counts, not the stored rate: totals are recomputed from blocked/scored so a
  // stale rate on a report can never contradict the table beside it.
  const weak = report({ blocked: 5, stepUp: 0, allowed: 5, blockRate: 0.5 });

  const overall = generateReport([weak], {
    format: 'text',
    failUnder: 0.8,
    failUnderScope: 'overall',
  });
  assert.match(overall, /GATE\s+FAIL — overall block rate/);

  const perScenario = generateReport([weak], {
    format: 'text',
    failUnder: 0.8,
    failUnderScope: 'scenario',
  });
  assert.match(perScenario, /GATE\s+FAIL — 1 scenario\(s\) below/);

  const passing = generateReport([report()], {
    format: 'text',
    failUnder: 0.8,
    failUnderScope: 'overall',
  });
  assert.match(passing, /GATE\s+PASS/);
});

test('totals are recomputed from counts, not from a stored rate', () => {
  // A scenario returning an inconsistent blockRate must not be able to move the
  // suite total away from what its own counts say.
  const { totals } = summarise([report({ blocked: 5, stepUp: 0, allowed: 5, blockRate: 0.99 })]);
  assert.equal(totals.blockRate, 0.5);
});

test('text output withholds a gate verdict on an unmeasurable run', () => {
  const text = generateReport(
    [report({ errors: 10, attempts: 10, scoredAttempts: 0, errorRate: 1, blockRate: 0 })],
    { format: 'text', failUnder: 0.8 }
  );
  assert.match(text, /GATE\s+n\/a/);
  assert.ok(!/GATE\s+FAIL/.test(text));
});

// ── end to end through a real run ───────────────────────────────────────

test('a real run produces latency percentiles and reason counts', async () => {
  const r = await run('credential-stuffing', {
    target: mockAdapter({
      defaultResponse: { decision: 'BLOCK', reasons: [{ code: 'NEW_DEVICE' }] },
    }),
    options: { targetUserIds: ['a', 'b'], attackerCount: 2, attemptsPerIp: 3, delayMs: 0 },
    maxRequestsPerSecond: Infinity,
  });

  assert.equal(r.latency.count, 6);
  assert.ok(Number.isFinite(r.latency.p95));
  assert.equal(r.reasonCounts.NEW_DEVICE, 6);
});

test('a suite report renders end to end', async () => {
  const result = await runSuite({
    name: 'e2e',
    target: mockAdapter({ defaultResponse: { decision: 'BLOCK', reasons: [{ code: 'X' }] } }),
    scenarios: [
      { id: 'credential-stuffing', options: { targetUserIds: ['a'], attackerCount: 1, attemptsPerIp: 2, delayMs: 0 } },
      { id: 'slow-drain', options: { targetUserId: 'v', withdrawalCount: 3, delayMs: 0 } },
    ],
    seed: 5,
    maxRequestsPerSecond: Infinity,
  });

  const html = generateReport(result, { format: 'html', targetName: 'Test target' });
  assert.match(html, /credential-stuffing/);
  assert.match(html, /slow-drain/);
  assert.match(html, /Test target/);

  const { totals } = summarise(result);
  assert.equal(totals.attempts, result.aggregate.attempts);
});

// ── currency ────────────────────────────────────────────────────────────

test('amounts render in the requested currency without converting', () => {
  // Amounts are minor-unit integers, so changing currency is presentation only.
  // Silently applying an FX rate would be worse than showing the wrong symbol.
  const r = report({ estimatedLossKobo: 60600000, attackerSucceeded: true });

  assert.match(generateReport([r], { format: 'text', currency: 'NGN' }), /₦606,000/);
  assert.match(generateReport([r], { format: 'text', currency: 'USD' }), /\$606,000/);
  assert.match(generateReport([r], { format: 'html', currency: 'GBP' }), /£606,000/);
});

test('currency defaults to NGN', () => {
  const r = report({ estimatedLossKobo: 100000, attackerSucceeded: true });
  assert.match(generateReport([r], { format: 'text' }), /₦1,000/);
});

test('zero-decimal currencies are not divided by 100', () => {
  // JPY has no minor unit; dividing would understate a figure a hundredfold.
  const r = report({ estimatedLossKobo: 60600000, attackerSucceeded: true });
  const text = generateReport([r], { format: 'text', currency: 'JPY' });
  assert.match(text, /60,600,000/);
});

test('an invalid currency code degrades instead of throwing mid-render', () => {
  // "ZZZ" is a real ISO 4217 code, so Intl accepts it — a genuinely malformed
  // code is what exercises the fallback.
  const r = report({ estimatedLossKobo: 100000, attackerSucceeded: true });
  const text = generateReport([r], { format: 'text', currency: 'NOTACURRENCY' });
  assert.match(text, /NOTACURRENCY\s1,000/);
});

test('formatted amounts are matched tolerantly of the separator Intl chooses', () => {
  // Intl puts a non-breaking space between a currency code and the amount in
  // many locales. Anything asserting on report text has to allow for it.
  const r = report({ estimatedLossKobo: 100000, attackerSucceeded: true });
  const text = generateReport([r], { format: 'text', currency: 'ZZZ' });
  assert.match(text, /ZZZ\s1,000/);
  assert.ok(/\u00a0/.test(text), 'expected Intl to use a non-breaking space here');
});

test('the neutral loss field is accepted alongside the naira-flavoured one', () => {
  const neutral = summarise([report({ estimatedLossMinor: 500000 })]);
  const legacy = summarise([report({ estimatedLossKobo: 500000 })]);
  assert.equal(neutral.totals.estimatedLossMinor, 500000);
  assert.equal(legacy.totals.estimatedLossMinor, 500000);
  // The old aggregate key keeps working for callers written against it.
  assert.equal(legacy.totals.estimatedLossKobo, 500000);
});

test('junit records the currency it rendered in', () => {
  const xml = generateReport([report({ estimatedLossKobo: 1, attackerSucceeded: true })], {
    format: 'junit',
    currency: 'KES',
  });
  assert.match(xml, /<property name="currency" value="KES"\/>/);
  assert.match(xml, /<property name="estimatedLossMinor"/);
});
