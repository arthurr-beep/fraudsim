/**
 * Run-scoped source of randomness.
 *
 * Every synthetic value `fraud-sim` produces — IPs, device fingerprints,
 * amounts, jitter, pool ordering — ultimately comes from one function here.
 * That indirection is what makes a run reproducible: seed it, and the same
 * attack replays choice for choice.
 *
 * ── Why AsyncLocalStorage rather than a module-level variable ──────────
 * A mutable module global would work for one run at a time, and would silently
 * corrupt two. Runs share this module, so a second run starting while a first
 * is awaiting would swap the generator underneath it and both would lose
 * reproducibility — with no error to say so. `AsyncLocalStorage` scopes the
 * generator to one async execution context instead, so concurrent runs stay
 * independent and no helper needs an extra parameter threaded through it.
 *
 * ── What seeding does and does not fix ────────────────────────────────
 * Seeding controls the *choices*: which IP, which device, which amount, in
 * which order. It does not control wall-clock time — payload timestamps still
 * come from the real clock (or a scenario's simulated one), so two seeded runs
 * are identical in shape but not byte-identical. That is enough to replay an
 * attack and to keep a CI block rate stable; it is not a byte-for-byte record.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

import { DeterministicRng } from './rng.js';
import { resolveLocale, DEFAULT_LOCALE } from '../locales/index.js';

const storage = new AsyncLocalStorage();

/**
 * The market in scope for the current run.
 *
 * Scoped exactly like the random source, and for the same reason: a module-level
 * variable would work for one run and silently corrupt two concurrent ones,
 * generating one market's payloads inside another market's run with no error to
 * show for it.
 */
const localeStorage = new AsyncLocalStorage();

/**
 * The default, unseeded source. Fine for generating attack traffic; useless
 * for replaying it.
 */
const systemSource = { next: () => Math.random() };

/**
 * The generator in scope right now — a seeded one inside `withSeed`, the
 * system one otherwise.
 *
 * Consumers only ever need `next()`, so any object with that method works.
 * Keeping the interface to a single function means a seeded run and an
 * unseeded one draw from identical distributions.
 *
 * @returns {{ next: () => number }}
 */
export function currentSource() {
  return storage.getStore() ?? systemSource;
}

/** A float in [0, 1) from the current source. */
export function randomFloat() {
  return currentSource().next();
}

/**
 * Run `fn` with a seeded generator in scope. Everything it does — including
 * across `await` boundaries — draws from that generator.
 *
 * @param {number} seed - Any integer. The same seed replays the same sequence.
 * @param {() => T} fn
 * @returns {T}
 * @template T
 */
export function withSeed(seed, fn) {
  if (!Number.isFinite(seed)) {
    throw new Error(`seed must be a finite number, received: ${JSON.stringify(seed)}`);
  }
  return storage.run(new DeterministicRng(seed), fn);
}

/** True when a seeded generator is currently in scope. */
export function isSeeded() {
  return storage.getStore() !== undefined;
}

/** The locale pack in scope, or the default when a run did not name one. */
export function currentLocale() {
  return localeStorage.getStore() ?? resolveLocale(DEFAULT_LOCALE);
}

/**
 * Run `fn` with a market in scope. Every generator inside it — account numbers,
 * banks, names, phone numbers, payload currency — draws from that pack.
 *
 * @param {string|object} locale - A bundled locale id, or a locale object.
 * @param {() => T} fn
 * @returns {T}
 * @template T
 */
export function withLocale(locale, fn) {
  return localeStorage.run(resolveLocale(locale), fn);
}
