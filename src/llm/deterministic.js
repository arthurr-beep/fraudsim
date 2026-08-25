/**
 * Deterministic LLM provider — a no-API attacker heuristic.
 *
 * fraud-sim's headline feature is an attacker that adapts based on what gets
 * blocked. The real thing calls an LLM; this is the fallback for when there's
 * no API key — CI, air-gapped machines, contributors without funds. It plays
 * the same role in the interface without any network calls.
 *
 * The "logic" is simple: look at why the last attempt was blocked and change
 * the thing that most likely caused it. It's seeded so a given history always
 * produces the same strategy — reproducibility matters more than cleverness.
 *
 * @example
 *   import { deterministic } from 'fraud-sim/llm';
 *
 *   const provider = deterministic({ seed: 42 });
 *   const strategy = await provider.generateStrategy({
 *     scenarioId: 'adaptive-attacker',
 *     history: [{ round: 1, decision: 'BLOCK', reasons: [{ code: 'IP_REPUTATION' }] }],
 *     round: 2,
 *     maxRound: 10,
 *   });
 *   // → { reasoning: '...', parameters: { ip: '...', ... } }
 */

import { DeterministicRng } from '../utils/rng.js';

// Substrings we look for in block-reason codes to decide what to change.
// Matched case-insensitively against each reason's `code`.
const IP_SIGNALS = ['IP', 'GEO', 'PROXY', 'VPN', 'SUBNET'];
const DEVICE_SIGNALS = ['DEVICE', 'FINGERPRINT', 'SESSION'];
const VELOCITY_SIGNALS = ['VELOCITY', 'RATE', 'FREQUENCY', 'BURST'];

const COMMON_USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
];

/**
 * @param {object} [config]
 * @param {number} [config.seed=1] - Seed for reproducible strategies.
 * @returns {{ name: string, generateStrategy: function }}
 */
export function deterministic(config = {}) {
  const seed = config.seed ?? 1;

  return {
    name: 'deterministic',

    /**
     * @param {object} input
     * @param {string} input.scenarioId
     * @param {Array} input.history - Prior rounds: { round, parameters?, decision, reasons? }
     * @param {number} input.round
     * @param {number} input.maxRound
     * @returns {Promise<{ reasoning: string, parameters: object }>}
     */
    async generateStrategy({ history = [], round = 1 } = {}) {
      // Seed off (seed, round) so each round is deterministic yet distinct —
      // otherwise "randomise everything" would return the same values forever.
      const rng = new DeterministicRng(seed + round);

      const lastAttempt = history.length > 0 ? history[history.length - 1] : null;
      const reasonCodes = extractReasonCodes(lastAttempt);
      const category = classify(reasonCodes);

      const parameters = {
        ip: rng.ip(),
        deviceFingerprint: rng.alphanumeric(32),
        userAgent: rng.pick(COMMON_USER_AGENTS),
        delayMs: rng.int(500, 3000),
      };

      let reasoning;
      switch (category) {
        case 'ip':
          reasoning = `Last attempt was blocked on an IP-related reason (${reasonCodes.join(', ')}). Rotating to a fresh IP address.`;
          break;
        case 'device':
          reasoning = `Last attempt was blocked on a device-related reason (${reasonCodes.join(', ')}). Rotating the device fingerprint and user agent.`;
          break;
        case 'velocity':
          // Velocity blocks: slow down AND change IP to dodge rate limits.
          parameters.delayMs = rng.int(5000, 15000);
          reasoning = `Last attempt was blocked on a velocity-related reason (${reasonCodes.join(', ')}). Waiting longer between attempts and changing IP.`;
          break;
        case 'none':
          reasoning =
            round === 1
              ? 'First round — establishing a residential-looking baseline before adapting.'
              : 'No clear block pattern to react to. Randomising all attributes to probe for gaps.';
          break;
        default:
          reasoning = `Blocked for an unrecognised reason (${reasonCodes.join(', ')}). Randomising all attributes.`;
      }

      return { reasoning, parameters };
    },
  };
}

function extractReasonCodes(attempt) {
  if (!attempt || !Array.isArray(attempt.reasons)) return [];
  return attempt.reasons
    .map((r) => (typeof r === 'string' ? r : r?.code))
    .filter((code) => typeof code === 'string');
}

function classify(reasonCodes) {
  if (reasonCodes.length === 0) return 'none';
  const matches = (signals) =>
    reasonCodes.some((code) => {
      const upper = code.toUpperCase();
      return signals.some((sig) => upper.includes(sig));
    });

  // Velocity and device are checked before IP because velocity codes can also
  // mention IP (e.g. IP_VELOCITY) and the velocity response is the stronger one.
  if (matches(VELOCITY_SIGNALS)) return 'velocity';
  if (matches(DEVICE_SIGNALS)) return 'device';
  if (matches(IP_SIGNALS)) return 'ip';
  return 'unknown';
}
