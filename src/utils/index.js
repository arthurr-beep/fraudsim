/**
 * Scenario-authoring toolkit — `fraud-sim/utils`.
 *
 * Everything the built-in scenarios use to construct an attack. Custom
 * scenarios should build on these rather than hand-rolling equivalents, for
 * two reasons that are easy to get wrong:
 *
 *   - **Randomness.** Every generator here draws from the run's random source,
 *     so a seeded run replays your scenario too. A scenario calling
 *     `Math.random()` directly silently opts out of that.
 *   - **Address realism.** `randomIp()` avoids private, loopback, CGNAT and
 *     documentation ranges. Addresses in those blocks resolve at no IP-intel
 *     provider, so a target scoring them falls back to neutral values and its
 *     geo and reputation rules never fire — the attack looks harmless because
 *     the defence was never given anything to look at.
 *
 * @example
 *   import { buildLoginPayload, randomIp, sleep } from 'fraud-sim/utils';
 */

// ── pacing ──────────────────────────────────────────────────────────────
export { sleep } from './sleep.js';
export { simulatedClock, humaniseMs } from './clock.js';

// ── decision tallying ───────────────────────────────────────────────────
export { newResults, countDecision, scoreAndCount } from './results.js';

// ── payload builders ────────────────────────────────────────────────────
export {
  buildLoginPayload,
  buildWithdrawalPayload,
  buildActionPayload,
  buildSignupPayload,
  buildCardAuthPayload,
  buildTransferPayload,
  newSessionId,
  newDeviceFingerprint,
  newReference,
  newPayee,
} from './faker-helpers.js';

// ── synthetic data ──────────────────────────────────────────────────────
export {
  randomFloat,
  randomInt,
  pickOne,
  alphanumeric,
  randomIp,
  ipInSameSubnet,
  randomUserAgent,
  randomAccountNumber,
  randomBank,
  randomFullName,
  randomPhoneNumber,
  randomCardBin,
  cardBins,
  randomLast4,
  newCardToken,
  DEMO_IP_POOL,
  pickDemoIp,
} from './random.js';

// ── reproducibility ─────────────────────────────────────────────────────
// `withSeed` is exported for tooling that needs to seed something outside a
// scenario run; inside a run the runner has already installed the source.
export { withSeed, isSeeded } from './random-source.js';
export { DeterministicRng } from './rng.js';
