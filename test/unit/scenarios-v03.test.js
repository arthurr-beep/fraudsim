import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../../src/index.js';
import { mockAdapter } from '../../src/adapters/mock.js';

const ALLOW = { decision: 'ALLOW', riskScore: 0.1, reasons: [] };
const BLOCK = { decision: 'BLOCK', riskScore: 0.95, reasons: [{ code: 'X' }] };

const permissive = () => mockAdapter({ defaultResponse: ALLOW });
const hostile = () => mockAdapter({ defaultResponse: BLOCK });

// ── card-testing ────────────────────────────────────────────────────────

test('card-testing never emits a full card number', async () => {
  // The library must not be usable to move real card data around.
  const target = permissive();
  await run('card-testing', {
    target,
    options: { cardCount: 5, delayMs: 0 },
  });

  for (const call of target._calls('scoreAction')) {
    const serialised = JSON.stringify(call);
    assert.ok(!/card_number|\bpan\b|full_card/i.test(serialised), 'payload leaked a PAN field');
    assert.match(call.details.card_bin, /^\d{6}$/);
    assert.match(call.details.card_last4, /^\d{4}$/);
    assert.match(call.details.card_token, /^tok_sim_/);
  }
});

test('card-testing escalates only after a probe is approved', async () => {
  const blocked = hostile();
  const blockedReport = await run('card-testing', {
    target: blocked,
    options: { cardCount: 5, delayMs: 0 },
  });
  assert.equal(blockedReport.cardsValidated, 0);
  assert.equal(blockedReport.escalations, 0, 'escalated despite every probe being blocked');
  assert.equal(blockedReport.attackerSucceeded, false);

  const open = permissive();
  const openReport = await run('card-testing', {
    target: open,
    options: { cardCount: 5, delayMs: 0 },
  });
  assert.equal(openReport.cardsValidated, 5);
  assert.equal(openReport.escalations, 5);
  assert.equal(openReport.attackerSucceeded, true);
  assert.ok(openReport.estimatedLossKobo > 0);
});

test('card-testing draws from a limited set of BINs', async () => {
  const target = permissive();
  await run('card-testing', {
    target,
    options: { cardCount: 12, binCount: 2, delayMs: 0 },
  });

  const bins = new Set(target._calls('scoreAction').map((c) => c.details.card_bin));
  assert.equal(bins.size, 2, 'BIN concentration is the signal — it must be bounded');
});

test('card-testing marks probes and escalations distinctly', async () => {
  const events = [];
  await run('card-testing', {
    target: permissive(),
    options: { cardCount: 3, delayMs: 0 },
    onEvent: (e) => events.push(e),
  });

  const stages = new Set(events.filter((e) => e.type === 'response').map((e) => e.stage));
  assert.deepEqual([...stages].sort(), ['escalation', 'probe']);
});

// ── promo-abuse ─────────────────────────────────────────────────────────

test('promo-abuse reuses a bounded set of devices and subnets', async () => {
  const target = permissive();
  await run('promo-abuse', {
    target,
    options: { accountCount: 12, deviceCount: 2, subnetCount: 1, delayMs: 0 },
  });

  const calls = target._calls('scoreAction');
  const devices = new Set(calls.map((c) => c.device_fingerprint));
  const subnets = new Set(calls.map((c) => c.ip_address.split('.').slice(0, 3).join('.')));

  assert.equal(devices.size, 2, 'device reuse is the signal — it must be bounded');
  assert.equal(subnets.size, 1, 'subnet clustering is the signal — it must be bounded');
});

test('promo-abuse funnels every account to one payout destination', async () => {
  const target = permissive();
  const report = await run('promo-abuse', {
    target,
    options: { accountCount: 6, delayMs: 0 },
  });

  const payouts = new Set(
    target._calls('scoreAction').map((c) => c.details.payout_account).filter(Boolean)
  );
  assert.equal(payouts.size, 1);
  assert.equal([...payouts][0], report.sharedPayoutAccount);
});

test('promo-abuse records where the first block landed', async () => {
  const report = await run('promo-abuse', {
    target: hostile(),
    options: { accountCount: 4, delayMs: 0 },
  });

  assert.equal(report.firstBlockedAtAccount, 1);
  assert.equal(report.accountsCreated, 0);
  assert.equal(report.bonusesClaimed, 0);
  assert.equal(report.estimatedLossKobo, 0);
});

test('promo-abuse counts bonuses only when the claim is allowed', async () => {
  const report = await run('promo-abuse', {
    target: permissive(),
    options: { accountCount: 5, bonusKobo: 100000, delayMs: 0 },
  });

  assert.equal(report.bonusesClaimed, 5);
  assert.equal(report.estimatedLossKobo, 500000);
});

// ── mule-network ────────────────────────────────────────────────────────

test('mule-network requires a source account', async () => {
  await assert.rejects(
    run('mule-network', { target: permissive() }),
    /sourceUserId/
  );
});

test('mule-network rejects an impossible retention ratio', async () => {
  await assert.rejects(
    run('mule-network', {
      target: permissive(),
      options: { sourceUserId: 's', retentionRatio: 1 },
    }),
    /retentionRatio/
  );
});

test('mule-network fans out then forwards to one destination', async () => {
  const target = permissive();
  const report = await run('mule-network', {
    target,
    options: { sourceUserId: 'src', muleCount: 4, delayMs: 0 },
  });

  const calls = target._calls('scoreWithdrawal');
  assert.equal(calls.length, 8); // 4 out + 4 forwarded

  const fanOut = calls.slice(0, 4);
  const forwards = calls.slice(4);

  for (const c of fanOut) assert.equal(c.user_id, 'src');
  const destinations = new Set(forwards.map((c) => c.transaction.payee_account));
  assert.equal(destinations.size, 1);
  assert.equal([...destinations][0], report.finalDestinationAccount);

  // Every mule forwards from its own account, not the source's.
  const muleSenders = new Set(forwards.map((c) => c.user_id));
  assert.equal(muleSenders.size, 4);
});

test('mule-network reports a high pass-through ratio', async () => {
  const report = await run('mule-network', {
    target: permissive(),
    options: { sourceUserId: 'src', muleCount: 3, retentionRatio: 0.05, delayMs: 0 },
  });

  // Money in ≈ money out is the laundering signature.
  assert.ok(report.passThroughRatio > 0.9, `expected high pass-through, got ${report.passThroughRatio}`);
  assert.equal(report.attackerSucceeded, true);
});

test('mule-network never forwards when the fan-out is stopped', async () => {
  const target = hostile();
  const report = await run('mule-network', {
    target,
    options: { sourceUserId: 'src', muleCount: 4, delayMs: 0 },
  });

  assert.equal(report.fanOutAllowed, 0);
  assert.equal(report.forwardTransfers, 0, 'forwarded from mules that were never funded');
  assert.equal(report.passThroughRatio, 0);
  assert.equal(report.attackerSucceeded, false);
});

// ── slow-drain ──────────────────────────────────────────────────────────

test('slow-drain spaces timestamps by the configured interval', async () => {
  const target = permissive();
  await run('slow-drain', {
    target,
    options: { targetUserId: 'v', withdrawalCount: 6, intervalMinutes: 120, delayMs: 0 },
  });

  const times = target._calls('scoreWithdrawal').map((c) => Date.parse(c.timestamp));
  for (let i = 1; i < times.length; i++) {
    const gapMinutes = (times[i] - times[i - 1]) / 60000;
    assert.ok(gapMinutes >= 119 && gapMinutes <= 121, `gap was ${gapMinutes} min`);
  }
});

test('slow-drain flags that its timing is simulated', async () => {
  const report = await run('slow-drain', {
    target: permissive(),
    options: { targetUserId: 'v', withdrawalCount: 3, delayMs: 0 },
  });

  // Callers must be able to tell that wall-clock time was not used, because
  // the result is meaningless against a server-timestamping target.
  assert.equal(report.simulatedTime, true);
  assert.ok(report.simulatedSpan);
});

test('slow-drain reports how much escaped before the first block', async () => {
  const open = await run('slow-drain', {
    target: permissive(),
    options: { targetUserId: 'v', withdrawalCount: 8, amountKobo: 1000000, amountJitterKobo: 0, delayMs: 0 },
  });
  assert.equal(open.firstBlockedAtWithdrawal, null);
  assert.equal(open.drainedKobo, 8000000);
  assert.equal(open.attackerSucceeded, true);

  const shut = await run('slow-drain', {
    target: hostile(),
    options: { targetUserId: 'v', withdrawalCount: 8, delayMs: 0 },
  });
  assert.equal(shut.firstBlockedAtWithdrawal, 1);
  assert.equal(shut.drainedKobo, 0);
  assert.equal(shut.attackerSucceeded, false);
});

// ── session-hijack ──────────────────────────────────────────────────────

test('session-hijack keeps one session id while the device changes', async () => {
  const target = permissive();
  await run('session-hijack', {
    target,
    options: { targetUserId: 'v', benignActionsBeforeHijack: 2, delayMs: 0 },
  });

  const all = [
    ...target._calls('scoreLogin'),
    ...target._calls('scoreAction'),
    ...target._calls('scoreWithdrawal'),
  ];

  const sessions = new Set(all.map((c) => c.session_id));
  assert.equal(sessions.size, 1, 'the stolen session id must be constant — that is the attack');

  const devices = new Set(all.map((c) => c.device_fingerprint));
  assert.equal(devices.size, 2, 'expected exactly the victim device and the attacker device');
});

test('session-hijack reports an undetected hijack as attacker success', async () => {
  const report = await run('session-hijack', {
    target: permissive(),
    options: { targetUserId: 'v', amountKobo: 5000000, delayMs: 0 },
  });

  assert.equal(report.hijackDetected, false);
  assert.equal(report.withdrawalDecision, 'ALLOW');
  assert.equal(report.attackerSucceeded, true);
  assert.equal(report.estimatedLossKobo, 5000000);
});

test('session-hijack stops early when the victim login is blocked', async () => {
  // Blocking the victim's own clean login is a false positive, not a defence.
  const target = hostile();
  const report = await run('session-hijack', {
    target,
    options: { targetUserId: 'v', delayMs: 0 },
  });

  assert.equal(report.loginDecision, 'BLOCK');
  assert.equal(target._calls('scoreWithdrawal').length, 0);
  assert.equal(report.attackerSucceeded, false);
});

// ── sim-swap-takeover ───────────────────────────────────────────────────

test('sim-swap-takeover walks reset, login, withdrawal in order', async () => {
  const report = await run('sim-swap-takeover', {
    target: permissive(),
    options: { targetUserId: 'v', delayMs: 0 },
  });

  assert.deepEqual(
    report.stages.map((s) => s.stage),
    ['password-reset', 'login', 'withdrawal']
  );
  assert.equal(report.blockedAtStage, null);
  assert.equal(report.attackerSucceeded, true);
});

test('sim-swap-takeover reports the stage that first pushed back', async () => {
  const report = await run('sim-swap-takeover', {
    target: hostile(),
    options: { targetUserId: 'v', delayMs: 0 },
  });

  assert.equal(report.blockedAtStage, 'password-reset');
  assert.equal(report.attackerSucceeded, false);
  assert.equal(report.estimatedLossKobo, 0);
});

test('sim-swap-takeover tells the target the number was ported', async () => {
  const target = permissive();
  await run('sim-swap-takeover', {
    target,
    options: { targetUserId: 'v', minutesSincePort: 30, delayMs: 0 },
  });

  const reported = target._reportedEvents().find((e) => e.type === 'sim-swap');
  assert.ok(reported, 'no sim-swap event reported');
  assert.equal(reported.data.user_id, 'v');
  assert.ok(Date.parse(reported.data.ported_at) > 0);
});

test('sim-swap-takeover carries the port time on the login payload', async () => {
  const target = permissive();
  await run('sim-swap-takeover', {
    target,
    options: { targetUserId: 'v', delayMs: 0 },
  });

  const login = target._calls('scoreLogin')[0];
  assert.equal(login.metadata.login_method, 'sms_otp');
  assert.ok(login.metadata.msisdn_ported_at, 'target cannot weigh the port without this');
});

// ── velocity-evasion ────────────────────────────────────────────────────

test('velocity-evasion paces attempts under the assumed limit', async () => {
  const target = permissive();
  const report = await run('velocity-evasion', {
    target,
    options: {
      targetUserId: 'v',
      attemptCount: 10,
      assumedLimit: 5,
      assumedWindowSeconds: 600,
      safetyMargin: 1.25,
      jitterRatio: 0,
      delayMs: 0,
    },
  });

  // 600s / 5 * 1.25 = 150s between attempts → 4 per window, under the limit of 5.
  assert.equal(report.pacingMs, 150000);
  assert.equal(report.effectiveRatePerWindow, 4);
  assert.ok(report.effectiveRatePerWindow < 5);

  const times = target._calls('scoreLogin').map((c) => Date.parse(c.timestamp));
  for (let i = 1; i < times.length; i++) {
    assert.equal(times[i] - times[i - 1], 150000);
  }
});

test('velocity-evasion reports evasion only when nothing pushed back', async () => {
  const evaded = await run('velocity-evasion', {
    target: permissive(),
    options: { targetUserId: 'v', attemptCount: 6, delayMs: 0 },
  });
  assert.equal(evaded.evaded, true);
  assert.equal(evaded.firstNonAllowAtAttempt, null);
  assert.equal(evaded.attackerSucceeded, true);

  const caught = await run('velocity-evasion', {
    target: hostile(),
    options: { targetUserId: 'v', attemptCount: 6, delayMs: 0 },
  });
  assert.equal(caught.evaded, false);
  assert.equal(caught.firstNonAllowAtAttempt, 1);
});

test('velocity-evasion counts a STEP_UP as pushback, not evasion', async () => {
  const target = mockAdapter({ defaultResponse: { decision: 'STEP_UP', riskScore: 0.5 } });
  const report = await run('velocity-evasion', {
    target,
    options: { targetUserId: 'v', attemptCount: 4, delayMs: 0 },
  });

  assert.equal(report.evaded, false);
  assert.equal(report.firstNonAllowAtAttempt, 1);
});

test('velocity-evasion validates its pacing inputs', async () => {
  await assert.rejects(
    run('velocity-evasion', {
      target: permissive(),
      options: { targetUserId: 'v', assumedLimit: 0 },
    }),
    /assumedLimit/
  );
  await assert.rejects(
    run('velocity-evasion', {
      target: permissive(),
      options: { targetUserId: 'v', safetyMargin: 0 },
    }),
    /safetyMargin/
  );
});

// ── cross-cutting ───────────────────────────────────────────────────────

test('every registered scenario reports a balanced decision tally', async () => {
  const cases = {
    'credential-stuffing': { targetUserIds: ['a', 'b'], attackerCount: 2, attemptsPerIp: 2, delayMs: 0 },
    'account-drain': { targetUserId: 'v', withdrawalCount: 2, delayBetweenWithdrawalsMs: 0, postLoginPauseMs: 0 },
    'adaptive-attacker': { targetUserId: 'v', maxRounds: 2, delayMs: 0 },
    'card-testing': { cardCount: 3, delayMs: 0 },
    'promo-abuse': { accountCount: 3, delayMs: 0 },
    'mule-network': { sourceUserId: 's', muleCount: 2, delayMs: 0 },
    'slow-drain': { targetUserId: 'v', withdrawalCount: 3, delayMs: 0 },
    'session-hijack': { targetUserId: 'v', delayMs: 0 },
    'sim-swap-takeover': { targetUserId: 'v', delayMs: 0 },
    'velocity-evasion': { targetUserId: 'v', attemptCount: 3, delayMs: 0 },
  };

  for (const [id, options] of Object.entries(cases)) {
    const report = await run(id, { target: permissive(), options });
    const counted = report.blocked + report.stepUp + report.allowed + (report.errors ?? 0);
    assert.equal(counted, report.attempts, `${id}: ${counted} counted vs ${report.attempts} attempts`);
    assert.ok(report.blockRate >= 0 && report.blockRate <= 1, `${id}: blockRate out of range`);
  }
});

test('scenarios needing scoreAction fail with a clear message when it is missing', async () => {
  // A target that only implements the login/withdrawal endpoints.
  const partial = {
    async scoreLogin() { return ALLOW; },
    async scoreWithdrawal() { return ALLOW; },
    async reportEvent() {},
  };

  await assert.rejects(
    run('card-testing', { target: partial, options: { cardCount: 2, delayMs: 0 } }),
    /scoreAction/
  );
});
