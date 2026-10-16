import { test } from 'node:test';
import assert from 'node:assert/strict';

import { run } from '../../src/index.js';
import { mockAdapter } from '../../src/adapters/mock.js';
import { LOCALES, localeIds, resolveLocale, DEFAULT_LOCALE } from '../../src/locales/index.js';
import { withLocale, currentLocale } from '../../src/utils/random-source.js';
import { randomAccountNumber, randomBank, randomPhoneNumber } from '../../src/utils/random.js';

const FAST = { maxRequestsPerSecond: Infinity };

// ── the packs ───────────────────────────────────────────────────────────

test('every bundled locale is complete', () => {
  for (const id of localeIds()) {
    const pack = LOCALES[id];
    assert.equal(pack.id, id, `${id} pack has a mismatched id`);

    for (const field of ['name', 'currency', 'minorUnits']) {
      assert.ok(pack[field] != null, `${id} is missing ${field}`);
    }
    for (const field of ['banks', 'firstNames', 'lastNames', 'cities']) {
      assert.ok(Array.isArray(pack[field]) && pack[field].length > 0, `${id}.${field} is empty`);
    }
    assert.equal(typeof pack.accountNumber, 'function');
    assert.equal(typeof pack.phoneNumber, 'function');

    for (const place of pack.cities) {
      assert.ok(place.lat >= -90 && place.lat <= 90, `${id}: bad latitude`);
      assert.ok(place.lon >= -180 && place.lon <= 180, `${id}: bad longitude`);
    }
  }
});

test('resolveLocale rejects an unknown market rather than guessing', () => {
  // Falling back would generate one market's data for a run that asked for
  // another, producing a result that looks valid and measures the wrong thing.
  assert.throws(() => resolveLocale('ZZ'), /Unknown locale/);
  assert.throws(() => resolveLocale('Atlantis'), /Available: /);
});

test('resolveLocale accepts a code in any case, and a pack object', () => {
  assert.equal(resolveLocale('ng').id, 'NG');
  assert.equal(resolveLocale('Ng').id, 'NG');

  const custom = { id: 'XX', currency: 'XXX', banks: ['B'], cities: [] };
  assert.equal(resolveLocale(custom), custom);
});

test('the default market is a real bundled pack', () => {
  assert.ok(localeIds().includes(DEFAULT_LOCALE));
  assert.equal(currentLocale().id, DEFAULT_LOCALE);
});

// ── scoping ─────────────────────────────────────────────────────────────

test('withLocale scopes the market and restores it afterwards', () => {
  assert.equal(currentLocale().id, DEFAULT_LOCALE);
  withLocale('NG', () => assert.equal(currentLocale().id, 'NG'));
  assert.equal(currentLocale().id, DEFAULT_LOCALE);
});

test('concurrent runs in different markets do not contaminate each other', async () => {
  // The reason the market is AsyncLocalStorage-scoped rather than a module
  // variable: two overlapping runs must each keep their own.
  const collect = (id) =>
    withLocale(id, async () => {
      const out = [];
      for (let i = 0; i < 5; i++) {
        await new Promise((r) => setTimeout(r, 1));
        out.push(currentLocale().id);
      }
      return out;
    });

  const [ng, gb] = await Promise.all([collect('NG'), collect('GB')]);
  assert.deepEqual(ng, Array(5).fill('NG'));
  assert.deepEqual(gb, Array(5).fill('GB'));
});

// ── generated data follows the market ───────────────────────────────────

test('account numbers match each market\'s real format', () => {
  // Format is not cosmetic: a target that validates account numbers rejects a
  // wrongly-shaped one before scoring it, and a run of 400s measures nothing.
  withLocale('NG', () => assert.match(randomAccountNumber(), /^\d{10}$/));
  withLocale('GB', () => assert.match(randomAccountNumber(), /^\d{8}$/));
  withLocale('KE', () => assert.match(randomAccountNumber(), /^\d{12}$/));
  withLocale('US', () => assert.match(randomAccountNumber(), /^\d{8,12}$/));
});

test('phone numbers match each market\'s dialling format', () => {
  // 07, 08 and 09 are all live Nigerian mobile prefixes — an earlier pattern
  // allowed only 07/08 and so passed roughly three runs in four.
  withLocale('NG', () => assert.match(randomPhoneNumber(), /^0[789]\d{9}$/));
  withLocale('US', () => assert.match(randomPhoneNumber(), /^\+1\d{10}$/));
  withLocale('GB', () => assert.match(randomPhoneNumber(), /^\+447\d{9}$/));
  withLocale('KE', () => assert.match(randomPhoneNumber(), /^\+2547\d{8}$/));
});

test('banks come from the market in scope', () => {
  for (const id of localeIds()) {
    withLocale(id, () => {
      assert.ok(LOCALES[id].banks.includes(randomBank()), `${id} produced a foreign bank`);
    });
  }
});

// ── through a run ───────────────────────────────────────────────────────

test('a run carries its market into the payloads and the report', async () => {
  for (const id of ['NG', 'US', 'GB', 'KE']) {
    const target = mockAdapter({ defaultResponse: { decision: 'ALLOW' } });
    const report = await run('mule-network', {
      target,
      locale: id,
      seed: 4,
      options: { sourceUserId: 'src', muleCount: 1, delayMs: 0 },
      ...FAST,
    });

    const transaction = target._calls('scoreWithdrawal')[0].transaction;
    assert.equal(transaction.currency, LOCALES[id].currency, `${id}: wrong payload currency`);
    assert.ok(LOCALES[id].banks.includes(transaction.payee_bank), `${id}: wrong payee bank`);
    assert.equal(report.locale, id, `${id}: report does not record the market`);
  }
});

test('an unseeded report does not claim a market it was not given', async () => {
  const report = await run('mule-network', {
    target: mockAdapter({ defaultResponse: { decision: 'BLOCK' } }),
    options: { sourceUserId: 'src', muleCount: 1, delayMs: 0 },
    ...FAST,
  });
  assert.ok(!('locale' in report));
});

test('a bad market fails the run loudly', async () => {
  await assert.rejects(
    run('mule-network', {
      target: mockAdapter(),
      locale: 'NOWHERE',
      options: { sourceUserId: 's', muleCount: 1, delayMs: 0 },
      ...FAST,
    }),
    /Unknown locale/
  );
});

// ── the renamed options ─────────────────────────────────────────────────

test('legacy kobo option names still work, with a deprecation warning', async () => {
  // The option validator rejects undeclared keys, so a rename without this
  // would turn into a hard break for every existing caller.
  const events = [];
  const report = await run('slow-drain', {
    target: mockAdapter({ defaultResponse: { decision: 'ALLOW' } }),
    options: { targetUserId: 'v', withdrawalCount: 2, amountKobo: 777, amountJitterKobo: 0, delayMs: 0 },
    onEvent: (e) => events.push(e),
    ...FAST,
  });

  assert.equal(report.attempts, 2);
  assert.equal(report.drainedMinor, 1554, 'the legacy value was not applied');

  const warning = events.find((e) => e.type === 'warning' && /amountKobo/.test(e.message));
  assert.ok(warning, 'expected a deprecation warning');
  assert.match(warning.message, /use "amountMinor"/);
});

test('a new-style option wins over its legacy alias', async () => {
  const report = await run('slow-drain', {
    target: mockAdapter({ defaultResponse: { decision: 'ALLOW' } }),
    options: {
      targetUserId: 'v',
      withdrawalCount: 1,
      amountMinor: 500,
      amountKobo: 999,
      amountJitterMinor: 0,
      delayMs: 0,
    },
    ...FAST,
  });

  assert.equal(report.drainedMinor, 500);
});
