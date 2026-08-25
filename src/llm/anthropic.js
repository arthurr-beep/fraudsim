/**
 * Anthropic-backed LLM provider.
 *
 * Same contract as the OpenAI provider (src/llm/openai.js) but built on the
 * Anthropic Messages API. Owns prompt construction and response parsing, falls
 * back to a randomised strategy on any error, and never throws.
 *
 * @example
 *   import { anthropic } from 'fraud-sim/llm';
 *
 *   const provider = anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
 *   await run('adaptive-attacker', { target, llm: provider, options: { targetUserId: 'u1' } });
 */

import { deterministic } from './deterministic.js';

const ENDPOINT = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';
const TIMEOUT_MS = 10000;
const DEFAULT_MAX_TOKENS = 1024;

const SYSTEM_PROMPT = `You are simulating a fraud actor probing a fintech security system.
You can only observe API responses — you cannot see the rules.
Your goal: based on the attack history, decide what to change for the next attempt.
Respond ONLY with valid JSON: { "reasoning": "...", "parameters": {...} }`;

/**
 * @param {object} config
 * @param {string} config.apiKey - Anthropic API key.
 * @param {string} [config.model='claude-sonnet-5']
 * @param {number} [config.maxTokens=1024]
 * @param {function} [config.fetch] - Injectable fetch, for testing.
 * @returns {{ name: string, generateStrategy: function }}
 */
export function anthropic(config = {}) {
  const { apiKey, model = 'claude-sonnet-5', maxTokens = DEFAULT_MAX_TOKENS } = config;
  const fetchImpl = config.fetch ?? globalThis.fetch;
  const fallback = deterministic({ seed: config.seed ?? 1 });

  return {
    name: 'anthropic',

    async generateStrategy(input) {
      const { scenarioId, history = [], round = 1, maxRound = 10 } = input ?? {};

      const userMessage = `Scenario: ${scenarioId}
Round: ${round} of ${maxRound}
History: ${JSON.stringify(history)}

What is your next strategy?`;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

      try {
        const res = await fetchImpl(ENDPOINT, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': API_VERSION,
          },
          body: JSON.stringify({
            model,
            max_tokens: maxTokens,
            system: SYSTEM_PROMPT,
            messages: [{ role: 'user', content: userMessage }],
          }),
          signal: controller.signal,
        });

        if (!res.ok) {
          return fallback.generateStrategy(input);
        }

        const body = await res.json();
        // Messages API returns content as an array of blocks; we want the text.
        const content = extractText(body);
        const parsed = parseStrategy(content);
        if (!parsed) {
          return fallback.generateStrategy(input);
        }
        return parsed;
      } catch {
        return fallback.generateStrategy(input);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

function extractText(body) {
  const blocks = body?.content;
  if (!Array.isArray(blocks)) return null;
  const textBlock = blocks.find((b) => b?.type === 'text' && typeof b.text === 'string');
  return textBlock ? textBlock.text : null;
}

/**
 * Parse a strategy from raw model text. Tolerates prose around the JSON by
 * extracting the first {...} block if a bare parse fails.
 * @returns {{ reasoning: string, parameters: object } | null}
 */
function parseStrategy(content) {
  if (typeof content !== 'string') return null;
  const obj = tryParse(content) ?? tryParse(extractJsonObject(content));
  if (!obj || typeof obj !== 'object') return null;
  const reasoning = typeof obj.reasoning === 'string' ? obj.reasoning : '';
  const parameters =
    obj.parameters && typeof obj.parameters === 'object' ? obj.parameters : {};
  return { reasoning, parameters };
}

function tryParse(str) {
  if (typeof str !== 'string') return null;
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

function extractJsonObject(str) {
  const start = str.indexOf('{');
  const end = str.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  return str.slice(start, end + 1);
}
