/**
 * LLM providers — pluggable strategy generators for the adaptive attacker.
 *
 * All providers share one interface:
 *   {
 *     name: string,
 *     async generateStrategy({ scenarioId, history, round, maxRound }) => {
 *       return { reasoning: string, parameters: object };
 *     }
 *   }
 *
 * `deterministic` needs no API and is the fallback used when no `llm` is passed
 * to a scenario. `openai` and `anthropic` call their respective APIs and fall
 * back to randomised behaviour on any error.
 */

export { deterministic } from './deterministic.js';
export { openai } from './openai.js';
export { anthropic } from './anthropic.js';
