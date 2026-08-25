/**
 * Scenario registry — all built-in scenarios.
 *
 * v0.1 shipped with two scenarios:
 *   - credential-stuffing
 *   - account-drain
 *
 * v0.2 adds:
 *   - adaptive-attacker (LLM-driven)
 *
 * v0.3 will add:
 *   - promo-abuse
 *   - card-testing
 *   - sim-swap-takeover
 *   - mule-network
 *   - slow-drain
 *   - session-hijack
 *   - velocity-evasion
 */

import credentialStuffing from './credential-stuffing.js';
import accountDrain from './account-drain.js';
import adaptiveAttacker from './adaptive-attacker.js';

export const scenarios = [credentialStuffing, accountDrain, adaptiveAttacker];
