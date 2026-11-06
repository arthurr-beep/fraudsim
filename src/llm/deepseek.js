/**
 * DeepSeek-backed LLM provider.
 *
 * Same contract as the OpenAI provider (src/llm/openai.js) — DeepSeek's API is
 * Chat Completions-shaped — but with DeepSeek's own defaults. Owns prompt
 * construction and response parsing, falls back to a randomised strategy on
 * any error, and never throws.
 *
 * ── On thinking mode ──────────────────────────────────────────────────
 * DeepSeek turns thinking on when a request does not say otherwise, and in
 * thinking mode it ignores `temperature` and allows up to 64K output tokens.
 * One round of this attacker is a small JSON decision, and a reply that
 * outlasts the timeout is indistinguishable from an outage: the round quietly
 * goes to the fallback. So thinking is off unless you ask for it, and asking
 * for it lengthens the timeout to match.
 *
 * @example
 *   import { deepseek } from 'fraud-sim/llm';
 *
 *   const provider = deepseek({ apiKey: process.env.DEEPSEEK_API_KEY });
 *   await run('adaptive-attacker', { target, llm: provider, options: { targetUserId: 'u1' } });
 */

import { deterministic } from './deterministic.js';

const DEFAULT_BASE_URL = 'https://api.deepseek.com';
const TIMEOUT_MS = 10000;
const THINKING_TIMEOUT_MS = 60000;

// JSON output requires the word "json" in the prompt; "valid JSON" below
// satisfies it.
const SYSTEM_PROMPT = `You are simulating a fraud actor probing a fintech security system.
You can only observe API responses — you cannot see the rules.
Your goal: based on the attack history, decide what to change for the next attempt.
Each history entry shows the exact parameters sent that round and the decision returned.
You control these parameters:
  "ip"                - source IPv4 address
  "userAgent"         - browser user agent string
  "deviceFingerprint" - device fingerprint; reuse one from history to replay that device
  "delayMs"           - how long you would wait before the next attempt
Omit a parameter to keep its previous value.
Respond ONLY with valid JSON: { "reasoning": "...", "parameters": {...} }`;

/**
 * @param {object} config
 * @param {string} config.apiKey - DeepSeek API key.
 * @param {string} [config.model='deepseek-flash'] - Or 'deepseek-v4-pro'.
 * @param {number} [config.temperature=0.7] - Ignored by DeepSeek in thinking mode.
 * @param {boolean} [config.thinking=false] - Let the model reason before answering.
 * @param {'low'|'high'|'max'} [config.reasoningEffort] - Only sent when thinking is on.
 * @param {number} [config.timeoutMs] - Defaults to 10000, or 60000 with thinking on.
 * @param {string} [config.baseUrl='https://api.deepseek.com']
 * @param {function} [config.fetch] - Injectable fetch, for testing.
 * @returns {{ name: string, generateStrategy: function }}
 */
export function deepseek(config = {}) {
  const {
    apiKey,
    model = 'deepseek-flash',
    temperature = 0.7,
    thinking = false,
    reasoningEffort,
  } = config;
  const endpoint = `${(config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '')}/chat/completions`;
  const timeoutMs = config.timeoutMs ?? (thinking ? THINKING_TIMEOUT_MS : TIMEOUT_MS);
  const fetchImpl = config.fetch ?? globalThis.fetch;
  const fallback = deterministic({ seed: config.seed ?? 1 });

  return {
    name: 'deepseek',

    async generateStrategy(input) {
      const { scenarioId, history = [], round = 1, maxRound = 10 } = input ?? {};

      const userMessage = `Scenario: ${scenarioId}
Round: ${round} of ${maxRound}
History: ${JSON.stringify(history)}

What is your next strategy?`;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const res = await fetchImpl(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model,
            messages: [
              { role: 'system', content: SYSTEM_PROMPT },
              { role: 'user', content: userMessage },
            ],
            response_format: { type: 'json_object' },
            ...(thinking
              ? {
                  thinking: { type: 'enabled' },
                  ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
                }
              : { thinking: { type: 'disabled' }, temperature }),
          }),
          signal: controller.signal,
        });

        if (!res.ok) {
          return fallback.generateStrategy(input);
        }

        const body = await res.json();
        // In JSON mode DeepSeek may answer with whitespace instead of JSON;
        // that fails to parse and falls back like any other bad reply.
        const content = body?.choices?.[0]?.message?.content;
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
