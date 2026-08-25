/**
 * Runner — orchestrates the lifecycle of a single scenario execution.
 *
 * Responsibilities:
 *   - Merge user options with scenario defaults
 *   - Provide the ScenarioContext (target, emit, signal)
 *   - Forward events to the user's onEvent callback
 *   - Wrap scenario errors with useful context
 *   - Emit a final 'summary' event when the scenario completes
 *
 * Non-responsibilities:
 *   - The runner does NOT know about HTTP, LLMs, faker, or specific scenarios.
 *     Every concrete behaviour lives in a scenario or an adapter.
 */

export class Runner {
  async run(scenario, config) {
    const startedAt = Date.now();

    const options = {
      ...(scenario.defaultOptions ?? {}),
      ...(config.options ?? {}),
    };

    const onEvent = config.onEvent ?? (() => {});
    const signal = config.signal ?? new AbortController().signal;

    // Wrap onEvent so we never let a buggy subscriber crash the runner.
    const emit = (event) => {
      try {
        onEvent(event);
      } catch (err) {
        // Subscribers should not break simulations.
        // We log to stderr but continue.
        // eslint-disable-next-line no-console
        console.error('[fraud-sim] subscriber threw:', err);
      }
    };

    const context = {
      options,
      target: config.target,
      llm: config.llm, // optional, used only by adaptive scenarios (v0.2+)
      emit,
      signal,
    };

    let report;
    try {
      report = await scenario.run(context);
    } catch (err) {
      emit({
        type: 'error',
        message: `Scenario "${scenario.id}" failed: ${err.message}`,
        details: { stack: err.stack },
        timestamp: Date.now(),
      });
      throw err;
    }

    // Normalise the report. Scenarios may return loose shapes; the runner
    // ensures the canonical fields exist so downstream tooling is reliable.
    const normalised = {
      scenarioId: scenario.id,
      scenarioName: scenario.name,
      startedAt,
      completedAt: Date.now(),
      durationMs: Date.now() - startedAt,
      attempts: report.attempts ?? 0,
      blocked: report.blocked ?? 0,
      stepUp: report.stepUp ?? 0,
      allowed: report.allowed ?? 0,
      blockRate:
        (report.attempts ?? 0) > 0 ? (report.blocked ?? 0) / report.attempts : 0,
      stepUpRate:
        (report.attempts ?? 0) > 0 ? (report.stepUp ?? 0) / report.attempts : 0,
      ...report, // scenarios can add custom fields
    };

    emit({
      type: 'summary',
      report: normalised,
      timestamp: Date.now(),
    });

    return normalised;
  }
}
