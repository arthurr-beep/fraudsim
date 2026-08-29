/**
 * Scenario registry — all built-in scenarios.
 *
 * v0.1 shipped:
 *   - credential-stuffing
 *   - account-drain
 *
 * v0.2 added:
 *   - adaptive-attacker (LLM-driven)
 *
 * v0.3 adds seven, completing the planned library:
 *   - card-testing
 *   - promo-abuse
 *   - mule-network
 *   - slow-drain
 *   - session-hijack
 *   - sim-swap-takeover
 *   - velocity-evasion
 *
 * Endpoint requirements differ by scenario. `credential-stuffing`,
 * `account-drain`, `adaptive-attacker`, `slow-drain` and `velocity-evasion`
 * need only `scoreLogin` / `scoreWithdrawal`. `card-testing`, `promo-abuse` and
 * `session-hijack` also need `scoreAction`; a scenario throws with a clear
 * message if the adapter does not implement what it needs.
 */

import credentialStuffing from './credential-stuffing.js';
import accountDrain from './account-drain.js';
import adaptiveAttacker from './adaptive-attacker.js';
import cardTesting from './card-testing.js';
import promoAbuse from './promo-abuse.js';
import muleNetwork from './mule-network.js';
import slowDrain from './slow-drain.js';
import sessionHijack from './session-hijack.js';
import simSwapTakeover from './sim-swap-takeover.js';
import velocityEvasion from './velocity-evasion.js';

export const scenarios = [
  credentialStuffing,
  accountDrain,
  adaptiveAttacker,
  cardTesting,
  promoAbuse,
  muleNetwork,
  slowDrain,
  sessionHijack,
  simSwapTakeover,
  velocityEvasion,
];
