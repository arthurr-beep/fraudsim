/**
 * OpenAI-backed LLM provider.
 *
 * Uses the OpenAI Chat Completions API to drive the adaptive attacker. The
 * provider owns prompt construction and response parsing. It is defensive by
 * design: any failure — network error, timeout, malformed JSON — falls back to
 * a randomised strategy rather than crashing the scenario. It never throws.
 *
 * @example
 *   import { openai } from 'fraud-sim/llm';
 *
 *   const provider = openai({ apiKey: process.env.OPENAI_API_KEY });
 *   await run('adaptive-attacker', { target, llm: provider, options: { targetUserId: 'u1' } });
 */

import { deterministic } from './deterministic.js';

const ENDPOINT = 'https://api.openai.com/v1/chat/completions';
const TIMEOUT_MS = 10000;

const SYSTEM_PROMPT = `You are simulating a fraud actor probing a fintech security system.
You can only observe API responses — you cannot see the rules.
Your goal: based on the attack history, decide what to change for the next attempt.
Respond ONLY with valid JSON: { "reasoning": "...", "parameters": {...} }`;

/**
 * @param {object} config
 * @param {string} config.apiKey - OpenAI API key.
 * @param {string} [config.model='gpt-4o']
 * @param {number} [config.temperature=0.7]
 * @param {function} [config.fetch] - Injectable fetch, for testing.
 * @returns {{ name: string, generateStrategy: function }}
 */
export function openai(config = {}) {
  const { apiKey, model = 'gpt-4o', temperature = 0.7 } = config;
  const fetchImpl = config.fetch ?? globalThis.fetch;
  // A seeded fallback so error paths are still deterministic.
  const fallback = deterministic({ seed: config.seed ?? 1 });

  return {
    name: 'openai',

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
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model,
            temperature,
            messages: [
              { role: 'system', content: SYSTEM_PROMPT },
              { role: 'user', content: userMessage },
            ],
            response_format: { type: 'json_object' },
          }),
          signal: controller.signal,
        });

        if (!res.ok) {
          return fallback.generateStrategy(input);
        }

        const body = await res.json();
        const content = body?.choices?.[0]?.message?.content;
        const parsed = parseStrategy(content);
        if (!parsed) {
          return fallback.generateStrategy(input);
        }
        return parsed;
      } catch {
        // Network error, timeout/abort, or JSON body error — fall back.
        return fallback.generateStrategy(input);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/**
 * Parse and validate a strategy from raw model output.
 * @returns {{ reasoning: string, parameters: object } | null}
 */
function parseStrategy(content) {
  if (typeof content !== 'string') return null;
  let obj;
  try {
    obj = JSON.parse(content);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;
  const reasoning = typeof obj.reasoning === 'string' ? obj.reasoning : '';
  const parameters =
    obj.parameters && typeof obj.parameters === 'object' ? obj.parameters : {};
  return { reasoning, parameters };
}
