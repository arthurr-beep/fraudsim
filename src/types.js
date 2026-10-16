/**
 * Shared type definitions.
 *
 * `fraud-sim` is plain JavaScript; these JSDoc typedefs are the single source
 * of truth for its public shapes, and `npm run build:types` compiles them into
 * the `.d.ts` files consumers actually see. Names referenced from JSDoc
 * elsewhere in the codebase resolve here.
 *
 * This module exports no runtime values.
 */

/**
 * What a target says about one scored event.
 *
 * `decision` is deliberately typed loosely: a target may return a value outside
 * the three canonical ones, and a scenario counts anything unrecognised as an
 * error rather than guessing. `'ERROR'` is produced by the adapters themselves
 * for failures that never reached a decision.
 *
 * @typedef {object} TargetResponse
 * @property {'ALLOW'|'STEP_UP'|'BLOCK'|'ERROR'|string} decision
 * @property {number|null} [riskScore]
 * @property {Array<{code: string, label?: string, weight?: number}>} [reasons]
 * @property {object} [raw] - The target's unmapped response body.
 * @property {number} [httpStatus]
 * @property {boolean} [infraError] - True when the call failed rather than
 *   being scored: rate limiting, a 5xx, a timeout. Excluded from block rates.
 * @property {string|null} [retryAfter]
 */

/**
 * The bridge between scenarios and the system under test.
 *
 * Not every target implements every method. A scenario that needs one you have
 * not provided fails with a message naming it, rather than silently skipping
 * that part of the attack.
 *
 * @typedef {object} TargetAdapter
 * @property {(payload: object) => Promise<TargetResponse>} [scoreLogin]
 * @property {(payload: object) => Promise<TargetResponse>} [scoreWithdrawal]
 * @property {(payload: object) => Promise<TargetResponse>} [scoreAction]
 * @property {(eventType: string, data: object) => Promise<void>} [reportEvent]
 */

/**
 * One thing that happened during a run.
 *
 * @typedef {object} ScenarioEvent
 * @property {'attempt'|'response'|'milestone'|'warning'|'error'|'summary'|'attacker_adapts'|string} type
 * @property {number} timestamp
 * @property {number} [round]
 * @property {string} [stage] - Which phase of a multi-stage attack this belongs to.
 * @property {object} [payload]
 * @property {TargetResponse} [response]
 * @property {number} [latencyMs]
 * @property {string} [message]
 * @property {object} [ipIntel] - Declared geo/reputation for the payload's IP,
 *   present only for pool-backed addresses.
 */

/**
 * What the runner provides to a scenario.
 *
 * @typedef {object} ScenarioContext
 * @property {object} options - Defaults merged with the caller's options.
 * @property {TargetAdapter} target - Already wrapped with the run's rate limit.
 * @property {object} [llm] - Present only for scenarios that use one.
 * @property {(event: ScenarioEvent) => void} emit
 * @property {AbortSignal} signal
 */

/**
 * An attack. Everything concrete about how traffic is generated lives here.
 *
 * `defaultOptions` is not documentation — it is the scenario's option surface.
 * The runner rejects any option key it does not declare, so a typo fails
 * loudly rather than silently falling back to a default.
 *
 * @typedef {object} Scenario
 * @property {string} id
 * @property {string} name
 * @property {string} description
 * @property {object} [defaultOptions]
 * @property {(ctx: ScenarioContext) => Promise<object>} run
 */

/**
 * Scenario metadata, as returned by `listScenarios()`.
 *
 * @typedef {object} ScenarioMetadata
 * @property {string} id
 * @property {string} name
 * @property {string} description
 * @property {object} [defaultOptions]
 */

/**
 * The result of one run.
 *
 * Note the denominators. `blockRate` and `stepUpRate` are computed over
 * `scoredAttempts`, not `attempts`: an attempt that failed before reaching a
 * decision is not evidence about the defence either way, so counting it as a
 * block would let a target look better the more it fell over. Check
 * `errorRate` before reading anything into a run.
 *
 * Scenarios add their own fields — `attackerSucceeded`, `estimatedLossKobo`,
 * `blockedAtStage` and so on — which is why this is not a closed shape.
 *
 * @typedef {object} ScenarioReport
 * @property {string} scenarioId
 * @property {string} scenarioName
 * @property {number} startedAt
 * @property {number} completedAt
 * @property {number} durationMs
 * @property {number} attempts - Everything the scenario tried.
 * @property {number} scoredAttempts - Attempts that came back with a decision.
 * @property {number} blocked
 * @property {number} stepUp
 * @property {number} allowed
 * @property {number} errors - Attempts that never reached a decision.
 * @property {number} blockRate - `blocked / scoredAttempts`.
 * @property {number} stepUpRate - `stepUp / scoredAttempts`.
 * @property {number} errorRate - `errors / attempts`.
 * @property {number} [seed] - Present only when the run was seeded.
 * @property {boolean} [simulatedTime] - True when the scenario advanced
 *   timestamps rather than sleeping; results are only faithful if the target
 *   derives its windows from the event timestamp.
 * @property {string} [simulatedSpan]
 * @property {boolean} [attackerSucceeded]
 * @property {number} [estimatedLossKobo]
 */

/**
 * Totals across a suite. Same denominator rule as a single run.
 *
 * @typedef {object} SuiteAggregate
 * @property {number} attempts
 * @property {number} scoredAttempts
 * @property {number} blocked
 * @property {number} stepUp
 * @property {number} allowed
 * @property {number} errors
 * @property {number} blockRate
 * @property {number} stepUpRate
 * @property {number} errorRate
 */

/**
 * The result of `runSuite()`.
 *
 * @typedef {object} SuiteReport
 * @property {string} suiteName
 * @property {string} startedAt
 * @property {string} completedAt
 * @property {number} concurrency - How many scenarios ran at once.
 * @property {ScenarioReport[]} scenarioReports
 * @property {SuiteAggregate} aggregate
 */

export {};
