import { test } from 'node:test';
import assert from 'node:assert/strict';

import { run, runSuite } from '../../src/index.js';
import { mockAdapter } from '../../src/adapters/mock.js';
import { generateReport, summarise } from '../../src/reporting/index.js';
import { outcomeFor, totalsFor, findingsFor } from '../../src/reporting/aggregate.js';

const customers = Array.from({ length: 6 }, (_, i) => `cust_${i}`);
const fast = { delayMs: 0 };
const allowAll = () => mockAdapter({ defaultResponse: { decision: 'ALLOW', reasons: [] } });

// ── the scenario ────────────────────────────────────────────────────────

test('legitimate-users requires customer ids', async () => {
  await assert.rejects(run('legitimate-users', { target: allowAll() }), /targetUserIds/);
});

test('rejects a behaviour rate outside 0..1', async () => {
  await assert.rejects(
    run('legitimate-users', {
      target: allowAll(),
      options: { targetUserIds: customers, travelRate: 2 },
    }),
    /travelRate/
  );
});

test('the report is labelled as legitimate traffic', async () => {
  const report = await run('legitimate-users', {
    target: allowAll(),
    options: { targetUserIds: customers, ...fast },
    seed: 1,
  });
  assert.equal(report.traffic, 'legitimate');
  assert.equal(report.customers, customers.length);
  assert.equal(report.simulatedTime, true);
});

test('warm-up is reported separately and excluded from the rates', async () => {
  const report = await run('legitimate-users', {
    target: allowAll(),
    options: { targetUserIds: customers, warmupLogins: 2, sessionsPerUser: 1, withdrawalRate: 0, ...fast },
    seed: 1,
  });
  assert.equal(report.warmup.attempts, customers.length * 2);
  assert.equal(report.attempts, customers.length); // one measured login each
});

test('customers behave like customers: browser agent, stable device, own address', async () => {
  const target = allowAll();
  await run('legitimate-users', {
    target,
    options: {
      targetUserIds: customers,
      newDeviceRate: 0,
      travelRate: 0,
      withdrawalRate: 1,
      newPayeeRate: 0,
      ...fast,
    },
    seed: 3,
  });

  const logins = target._calls('scoreLogin');
  assert.ok(logins.every((p) => p.user_agent.startsWith('Mozilla/')));

  for (const id of customers) {
    const mine = logins.filter((p) => p.user_id === id);
    assert.equal(new Set(mine.map((p) => p.device_fingerprint)).size, 1, `${id} kept one device`);
    assert.equal(new Set(mine.map((p) => p.ip_address)).size, 1, `${id} kept one address`);
  }
  // Each customer has their own address, so no users-per-IP rule is tripped
  // by the simulator rather than by the defence.
  assert.equal(new Set(logins.map((p) => p.ip_address)).size, customers.length);

  const withdrawals = target._calls('scoreWithdrawal');
  assert.ok(withdrawals.length > 0);
  assert.ok(withdrawals.every((w) => w.transaction.is_new_payee === false));
});

test('a withdrawal rides on the session, device and address of its login', async () => {
  const target = allowAll();
  await run('legitimate-users', {
    target,
    options: { targetUserIds: ['solo'], sessionsPerUser: 3, withdrawalRate: 1, ...fast },
    seed: 5,
  });
  const logins = target._calls('scoreLogin');
  for (const w of target._calls('scoreWithdrawal')) {
    const login = logins.find((l) => l.session_id === w.session_id);
    assert.ok(login, 'withdrawal shares a login session');
    assert.equal(w.device_fingerprint, login.device_fingerprint);
    assert.equal(w.ip_address, login.ip_address);
    assert.ok(Date.parse(w.timestamp) > Date.parse(login.timestamp));
  }
});

test('sessions are spread over simulated days, not sent as a burst', async () => {
  const target = allowAll();
  await run('legitimate-users', {
    target,
    options: { targetUserIds: ['solo'], warmupLogins: 0, sessionsPerUser: 3, sessionGapHours: 24, ...fast },
    seed: 2,
  });
  const times = target._calls('scoreLogin').map((p) => Date.parse(p.timestamp));
  assert.ok(times[1] - times[0] > 20 * 3_600_000);
  assert.ok(times[2] - times[1] > 20 * 3_600_000);
});

test('blocks are counted as false positives, by customer and by stage', async () => {
  // Block every login after warm-up: every measured event is a false positive.
  let n = 0;
  const target = {
    async scoreLogin() {
      n++;
      return n <= customers.length
        ? { decision: 'ALLOW', reasons: [] }
        : { decision: 'BLOCK', reasons: [{ code: 'LOGIN_VELOCITY_USER' }] };
    },
    async scoreWithdrawal() {
      return { decision: 'ALLOW', reasons: [] };
    },
  };
  const report = await run('legitimate-users', {
    target,
    options: { targetUserIds: customers, warmupLogins: 1, sessionsPerUser: 2, travelRate: 0, newDeviceRate: 0, ...fast },
    seed: 1,
  });

  assert.equal(report.blocked, customers.length * 2);
  assert.equal(report.falsePositiveRate, 1);
  assert.equal(report.customersBlocked, customers.length);
  assert.equal(report.byStage['routine-login'].blocked, customers.length * 2);
  assert.deepEqual(Object.keys(report.falsePositiveReasons), ['LOGIN_VELOCITY_USER']);
  // A blocked customer does not go on to pay anyone.
  assert.equal(report.warmup.blocked, 0);
});

test('a refused payment is counted as value blocked', async () => {
  const target = mockAdapter({
    scoreLogin: [{ decision: 'ALLOW', reasons: [] }],
    scoreWithdrawal: [{ decision: 'BLOCK', reasons: [{ code: 'NEW_PAYEE_HIGH_AMOUNT' }] }],
  });
  const report = await run('legitimate-users', {
    target,
    options: { targetUserIds: ['solo'], sessionsPerUser: 2, withdrawalRate: 1, newPayeeRate: 0, ...fast },
    seed: 4,
  });
  const sent = target._calls('scoreWithdrawal').reduce((a, w) => a + w.transaction.amount, 0);
  assert.equal(report.valueBlockedMinor, sent);
  assert.ok(sent > 0);
});

test('a seeded run replays identically', async () => {
  const once = async () => {
    const target = allowAll();
    await run('legitimate-users', {
      target,
      options: { targetUserIds: customers, ...fast },
      seed: 9,
    });
    return JSON.stringify(
      target._calls('scoreLogin').map((p) => [p.user_id, p.ip_address, p.device_fingerprint])
    );
  };
  assert.equal(await once(), await once());
});

// ── reporting ───────────────────────────────────────────────────────────

const legitReport = (over = {}) => ({
  scenarioId: 'legitimate-users',
  traffic: 'legitimate',
  attempts: 40,
  scoredAttempts: 40,
  blocked: 2,
  stepUp: 4,
  allowed: 34,
  errors: 0,
  blockRate: 0.05,
  errorRate: 0,
  falsePositiveRate: 0.05,
  frictionRate: 0.15,
  customers: 12,
  customersBlocked: 2,
  valueBlockedMinor: 3000000,
  byStage: { 'travel-login': { events: 2, allowed: 0, stepUp: 0, blocked: 2 } },
  falsePositiveReasons: { IP_KNOWN_ABUSIVE: 2 },
  ...over,
});

const attackReport = (over = {}) => ({
  scenarioId: 'credential-stuffing',
  traffic: 'attack',
  attempts: 100,
  scoredAttempts: 100,
  blocked: 90,
  stepUp: 5,
  allowed: 5,
  errors: 0,
  blockRate: 0.9,
  errorRate: 0,
  ...over,
});

test('a blocked customer is a false positive, not a catch', () => {
  assert.equal(outcomeFor(legitReport()).kind, 'false-positives');
  assert.equal(outcomeFor(legitReport({ blocked: 0, stepUp: 4 })).kind, 'friction');
  assert.equal(outcomeFor(legitReport({ blocked: 0, stepUp: 0 })).kind, 'clean');
  // Never "Never blocked" — for a customer that is the goal.
  assert.notEqual(outcomeFor(legitReport({ blocked: 0 })).kind, 'through');
});

test('legitimate traffic is kept out of the attack block rate', () => {
  const totals = totalsFor([attackReport(), legitReport({ blocked: 40, allowed: 0, stepUp: 0 })]);
  assert.equal(totals.attempts, 100);
  assert.equal(totals.blockRate, 0.9);
  assert.equal(totals.scenarios, 1);
  assert.equal(totals.legitimate.blocked, 40);
  assert.equal(totals.legitimate.falsePositiveRate, 1);
});

test('a run with no legitimate traffic reports none, not zero', () => {
  assert.equal(totalsFor([attackReport()]).legitimate, null);
});

test('blocked customers are a high-severity finding with the evidence', () => {
  const [finding] = findingsFor([legitReport()]);
  assert.equal(finding.severity, 'high');
  assert.match(finding.title, /Legitimate customers were blocked/);
  const stats = Object.fromEntries(finding.stats);
  assert.equal(stats['blocked on travel-login'], '2 of 2');
  assert.equal(stats['top reasons'], 'IP_KNOWN_ABUSIVE');
});

test('the text report gives customers their own table and gate', () => {
  const text = generateReport([attackReport(), legitReport()], {
    format: 'text',
    maxFalsePositiveRate: 0.01,
  });
  assert.match(text, /LEGITIMATE TRAFFIC/);
  assert.match(text, /CUSTOMERS {2}40 events · 5\.0% blocked \(false positives\)/);
  assert.match(text, /GATE {3}FAIL — false-positive rate 5\.0% is above the 1\.0% ceiling/);
  // The attack total is unaffected by the customers.
  assert.match(text, /TOTAL {2}100 events · 100 scored · 90\.0% blocked/);
});

test('junit fails customer traffic on any block, or above the ceiling when set', () => {
  const xml = generateReport([legitReport()], { format: 'junit' });
  assert.match(xml, /type="FalsePositives"/);

  const within = generateReport([legitReport()], { format: 'junit', maxFalsePositiveRate: 0.1 });
  assert.doesNotMatch(within, /<failure/);

  // Never held to the attack floor.
  const clean = generateReport([legitReport({ blocked: 0, falsePositiveRate: 0, blockRate: 0 })], {
    format: 'junit',
    failUnder: 0.85,
  });
  assert.doesNotMatch(clean, /<failure/);
});

test('the html report shows what the defence cost customers', () => {
  const html = generateReport([attackReport(), legitReport()], { format: 'html', currency: 'NGN' });
  assert.match(html, /What it cost ordinary customers/);
  assert.match(html, /False-positive rate/);
  assert.match(html, /2 of 12 customers locked out/);
});

test('summarise carries the false-positive fields per scenario', () => {
  const { scenarios, totals } = summarise([attackReport(), legitReport()]);
  const legit = scenarios.find((s) => s.traffic === 'legitimate');
  assert.equal(legit.falsePositiveRate, 0.05);
  assert.equal(legit.customersBlocked, 2);
  assert.equal(totals.legitimate.customers, 12);
});

test('a suite keeps the two halves apart end to end', async () => {
  const target = mockAdapter({
    defaultResponse: { decision: 'BLOCK', reasons: [{ code: 'EVERYTHING' }] },
  });
  const result = await runSuite({
    target,
    seed: 1,
    maxRequestsPerSecond: Infinity,
    scenarios: [
      { id: 'legitimate-users', options: { targetUserIds: customers, ...fast } },
      { id: 'credential-stuffing', options: { targetUserIds: ['victim'], attackerCount: 2, delayMs: 0 } },
    ],
  });

  // Blocking everything: a perfect block rate, and every customer refused.
  assert.equal(result.aggregate.blockRate, 1);
  assert.equal(result.aggregate.legitimate.falsePositiveRate, 1);
  assert.equal(result.aggregate.legitimate.customersBlocked, customers.length);
});

test('velocity blocks on time-compressed customer traffic carry the clock caveat', () => {
  const [finding] = findingsFor([
    legitReport({
      simulatedTime: true,
      simulatedSpan: '1.4 days',
      falsePositiveReasons: { LOGIN_VELOCITY_USER: 3, NEW_DEVICE: 1 },
    }),
  ]);
  assert.match(finding.detail, /LOGIN_VELOCITY_USER count events in a time window/);
  assert.match(finding.detail, /1\.4 days/);

  // A block for a non-windowed reason gets no such excuse.
  const [plain] = findingsFor([legitReport({ simulatedTime: true })]);
  assert.doesNotMatch(plain.detail, /Caveat/);
});

test('a customers-only run prints no empty attack table', () => {
  const text = generateReport([legitReport()], { format: 'text' });
  assert.doesNotMatch(text, /SCENARIO\s+EVENTS/);
  assert.doesNotMatch(text, /TOTAL\s+0 events/);
  assert.match(text, /LEGITIMATE TRAFFIC/);
});
