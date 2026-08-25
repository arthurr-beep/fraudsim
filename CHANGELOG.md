# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] — LLM Adaptive Attacker

### Added

- **`adaptive-attacker` scenario** — the headline feature. An attacker that
  probes a login endpoint and, after each block, asks an LLM what to change for
  the next attempt (IP, device fingerprint, user agent, timing). Emits a new
  `attacker_adapts` event carrying the LLM's reasoning *before* each adapted
  attempt. Reports `rounds`, `outcome` (`attacker_succeeded` /
  `attacker_defeated`), and `strategyHistory`.
- **LLM provider interface and three providers** (`fraud-sim/llm`):
  - `deterministic` — no-API fallback using seeded heuristics; reproducible.
    Used automatically when a scenario is run without an `llm`.
  - `openai` — OpenAI Chat Completions provider.
  - `anthropic` — Anthropic Messages API provider (default model
    `claude-sonnet-5`).
  Both API providers fall back to a randomised strategy on any error (timeout,
  non-2xx, invalid JSON) and never throw.
- `src/utils/rng.js` — `DeterministicRng`, a seeded PRNG for reproducible runs.
- `src/streaming/sse.js` — `sseStream(res)` Server-Sent Events helper for
  streaming simulation events to a browser dashboard (Task 2.6). Sets SSE
  headers, frames events as `data: {...}\n\n`, sends a `{"type":"done"}`
  sentinel on `close()`, and queues writes under backpressure until `drain`.
- `./llm` export subpath in `package.json`.
- 37 new tests (72 total, all passing).

### Fixed

- `package.json` declared a `"./streaming"` export subpath but `src/streaming/`
  did not exist — `import 'fraud-sim/streaming'` failed with
  `ERR_MODULE_NOT_FOUND`. The directory now exists and the subpath resolves.

### Notes

- The `adaptive-attacker` scenario paces rounds by `options.delayMs`, not the
  attacker's chosen delay. The attacker's timing decision is recorded in the
  `attacker_adapts` event and `strategyHistory` but not enacted as a real
  wall-clock wait — a velocity-evasion delay of 5–15s per round would make a
  simulation take minutes for no benefit.

## [0.1.0] — Initial release

### Added

- Core abstractions: `Runner`, `Scenario`, `TargetAdapter`, `ScenarioEvent`
- Public API: `run()`, `runSuite()`, `listScenarios()`, `registerScenario()`, `unregisterScenario()`
- Two scenarios:
  - `credential-stuffing` — botnet-style login attacks with rotating IPs and user agents
  - `account-drain` — takeover, password change, and rapid withdrawal pattern
- Three target adapters:
  - `httpAdapter` — works against any REST API via configurable `responseMap`
  - `mockAdapter` — sequenced responses for unit testing scenarios
  - `loggingAdapter` — inspects payloads without sending to a network
- Abort-aware execution via `AbortSignal`
- Structured event stream with typed events: `attempt`, `response`, `milestone`, `error`, `summary`
- Subscriber isolation: buggy event handlers do not crash simulations
- Safety defaults: maximum attempt ceilings, paced delays, no infinite loops
- 35 tests (33 unit, 2 integration) — all passing in under 1 second
- Examples directory with three runnable demos:
  - `basic-credential-stuffing/` — colored CLI output of an attack
  - `account-drain-demo/` — narrated drain attack
  - `express-mock-target/` — local target to test against

### Design decisions

- No npm dependencies — fraud-sim ships zero runtime dependencies. Internal `random.js` replaces faker.
- Target-agnostic by design — no FriskLayer-specific code paths
- ES modules only (Node 20+)
- Tests use the built-in Node test runner (no Jest, no Mocha)

### Out of scope (Phase 2+)

- LLM-driven adaptive attacker (v0.2)
- Server-Sent Events helper (v0.2)
- Seven additional scenarios (v0.3)
- CLI runner (v0.3)
- Reporting and benchmarking suite (v0.4)
- Community scenario library (v1.0)

See `IMPLEMENTATION_GUIDE.md` for the detailed phase plan.

[Unreleased]: https://github.com/arthurr-beep/fraudsim/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/arthurr-beep/fraudsim/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/arthurr-beep/fraudsim/releases/tag/v0.1.0
