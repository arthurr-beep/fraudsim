# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added — reproducible runs

- **`seed` option on `run()` and `runSuite()`.** A seeded run replays choice
  for choice: same IPs, devices, amounts and ordering. Previously `rng.js`
  existed but was wired only into the deterministic LLM provider, while every
  payload value came from `Math.random()` — so the "reproducible runs" this
  changelog already claimed were not achievable. All randomness now flows
  through three primitives (`randomInt`, `pickOne`, `alphanumeric`) drawing on
  a run-scoped source.

  Seeding controls generated values, not wall-clock time; payload timestamps
  still come from the real clock, so seeded runs are identical in shape rather
  than byte-identical. Reports carry `seed` only when one was given, so a
  report never implies reproducibility it does not have. `runSuite` derives a
  distinct seed per scenario so a suite is reproducible as a whole.

  The source is scoped with `AsyncLocalStorage` rather than a module-level
  variable: a global would work for one run and silently corrupt two, since a
  second run starting mid-await would swap the generator underneath the first
  with no error to show for it. Concurrent seeded runs stay independent, which
  also keeps the door open for parallel execution.

### Added — enforced rate limiting

- **`maxRequestsPerSecond`, default 25.** Applied by wrapping the target
  adapter, so the ceiling holds for user-written scenarios too rather than
  depending on each scenario pacing itself. Sliding window, so a run cannot
  spend its whole budget in the first 50ms of each second. `Infinity` disables
  it. A run that was actually held back emits a `warning` saying by how much —
  relevant before reading anything into its latency numbers.

  This replaces a documentation claim with a mechanism: the README previously
  said safety came from "modest attack counts, 200ms delays", which had also
  gone stale (defaults are 100ms since the calibration work).

### Added — `fraud-sim/utils` subpath

- The scenario-authoring toolkit is now importable: `simulatedClock`,
  `newResults`, `scoreAndCount`, every payload builder, and the synthetic-data
  helpers. Previously the README documented writing custom scenarios while the
  helpers every built-in uses were unreachable, so authors had to hand-roll
  equivalents — and would drop out of seeded reproducibility by reaching for
  `Math.random()`.
- The README's custom-scenario example is rewritten on top of it. The old one
  used `@faker-js/faker` (not a dependency — the library deliberately avoids
  it) and hardcoded `192.168.1.100`, an address no IP-intel provider resolves,
  which silently disables the target's geo and reputation rules.

### Fixed

- Dead documentation links: `docs/EXTENDING.md` (never existed).
- `rng.js` header described `random.js` as using `Math.random()`, no longer true.

### Tests

- 26 new tests (149 total): seed replay and isolation across `await` and under
  concurrency, seeded suites, non-numeric seed rejection, sliding-window rate
  limiting, adapter surface preservation through the throttle wrapper, clock
  arithmetic and validation, `scoreAndCount` error paths and stage tagging, and
  the `fraud-sim/utils` surface.


### Fixed — measurement correctness (breaking)

- **HTTP failures were counted as blocks.** `httpAdapter` mapped every non-2xx
  response to `decision: 'BLOCK'` with `riskScore: 1`. A target that rate-limited
  the simulator, returned 500s, or was simply unreachable therefore scored as a
  *better* defence the more it failed — and the CI block-rate gate documented in
  the README would pass on a staging box that was down. Non-2xx responses now
  return `decision: 'ERROR'` with `infraError: true` and a reason code naming the
  cause (`RATE_LIMITED`, `SERVER_ERROR`, `AUTH_ERROR`, `ENDPOINT_NOT_FOUND`).
  A `Retry-After` header, when present, is surfaced as `retryAfter`.

  APIs that genuinely signal a block by status can opt in per status:
  `httpAdapter({ baseUrl, blockOnStatus: [403] })`.

- **Rates now exclude unscored attempts.** Reports gain `scoredAttempts`
  (`attempts - errors`) and `errorRate`. `blockRate` and `stepUpRate` are
  computed over `scoredAttempts` rather than all attempts, so an attempt that
  never received a decision is neither credited to the defence nor held against
  it. Runs with any errors emit a `warning` event stating how much of the run
  failed. For runs with no errors, every rate is unchanged.

  Derived rates are also computed *after* merging a scenario's own report
  fields, so a scenario can no longer shadow them.

### Added

- **Unknown scenario options are rejected.** A scenario's option surface is its
  `defaultOptions`; anything else throws, with a "did you mean" suggestion from
  an edit-distance match. Previously `attemptsPerIP` (capital P) silently fell
  back to the default of `attemptsPerIp` and the run completed looking healthy
  while measuring something else. Scenarios registered without `defaultOptions`
  skip the check.
- 6 tests covering HTTP status classification, `blockOnStatus`, `Retry-After`,
  option rejection with suggestions, and error-aware rate arithmetic
  (122 total, all passing).


### Added — the remaining seven scenarios (library complete)

The scenario library planned in `docs/ATTACK_PATTERNS.md` now ships in full.
Ten scenarios are registered; `listScenarios()` is the runtime source of truth.

- **`card-testing`** — probes a list of stolen cards with micro-authorisations,
  then escalates to a real charge on each card that comes back approved.
  Reports `cardsValidated`, `escalationsAllowed` and `estimatedLossKobo`; the
  headline result is whether any escalated charge got through, not the block
  rate. Never generates Luhn-valid numbers and never emits a full PAN — payloads
  carry an opaque token, a published sandbox BIN, and four synthetic digits.
- **`promo-abuse`** — one actor farming signup bonuses across many accounts,
  with configurable device and /24 reuse and a shared payout destination.
  Reports `firstBlockedAtAccount`, because a system that catches account 40 has
  already paid 39 bonuses.
- **`mule-network`** — fan-out from a source to mule accounts, then fan-in to a
  common destination with a configurable retention cut. Reports
  `passThroughRatio`; a system scoring transactions in isolation passes cleanly.
- **`slow-drain`** — withdrawals below every short-window threshold, spread over
  simulated days. Reports how much left before anything fired.
- **`session-hijack`** — a legitimate login whose session is then replayed from
  a different device and network. Tests whether the *session* is scored or only
  the login. Treats a block on the victim's own opening login as a false
  positive and stops.
- **`sim-swap-takeover`** — number ported, OTP redirected, then password reset →
  login → withdrawal, every stage confirmed by an OTP the attacker receives.
  Reports `stages` and `blockedAtStage`; `null` means the whole chain succeeded.
- **`velocity-evasion`** — an attacker pacing attempts under a rate limit they
  believe they have inferred. The assumed limit is a parameter, so running it
  with a deliberately wrong belief shows how much margin your thresholds have.

### Added — supporting utilities

- **`src/utils/clock.js`** — `simulatedClock()` advances the payload
  `timestamp` instead of sleeping, so a four-day slow drain runs in seconds.
  Scenarios using it set `simulatedTime: true` and `simulatedSpan` on the
  report and emit a milestone explaining the caveat: the result is only
  faithful if the target derives its windows from the event timestamp rather
  than server-side arrival time.
- **`src/utils/results.js`** — shared decision tallying and a `scoreAndCount()`
  helper that emits the attempt/response pair, updates the tally, and throws a
  clear error naming the missing method when an adapter does not implement the
  endpoint a scenario needs.
- **Payload builders** for the new event types: `buildActionPayload`,
  `buildSignupPayload`, `buildCardAuthPayload`, `buildTransferPayload`.
- **Card, subnet and phone helpers** in `random.js`: `randomCardBin`,
  `cardBins`, `randomLast4`, `newCardToken`, `ipInSameSubnet`,
  `randomPhoneNumber`.
- 29 new tests (116 total, all passing), covering PAN-leak prevention, BIN
  concentration, device/subnet reuse bounds, mule graph shape, drain timestamp
  spacing, session-id continuity, SIM-swap stage ordering, evasion pacing
  arithmetic, and a cross-cutting check that every scenario's decision tally
  balances against its attempt count.

### Fixed

- **`buildActionPayload` dropped sibling detail fields.** Spreading `overrides`
  wholesale replaced the entire `details` object, so a caller adding one field
  silently discarded the rest — a card payload could lose its BIN and last4 and
  still look well-formed. `details` is now merged; top-level keys still
  override.


### Changed — attack calibration (behavioural, review before upgrading)

The v0.2 defaults sat *below* the thresholds that rule engines commonly ship
with, so scenarios ran without tripping the rules they were written to trip.
Against a correctly configured target this reported a near-zero block rate that
said nothing about the defence — the attack was simply too quiet to catch.
These defaults now cross those thresholds.

- **`credential-stuffing` accepts `targetUserIds`** (an array) and sprays across
  the whole list, one account per attempt. A credential dump is a list of
  victims, not one victim retried — and "one IP, many users" rules (limit
  commonly 10 accounts) could never fire against the old single-user shape.
  `targetUserId` still works and is treated as a one-element list; the scenario
  emits a `milestone` warning when only one account is supplied.
- **`credential-stuffing` defaults retuned**: `attemptsPerIp` 3 → 25 (per-IP
  velocity limits commonly sit at 20 per 5 min, so 3 never fired),
  `attackerCount` 50 → 20, `delayMs` 200 → 100, `maxTotalAttempts` 200 → 500.
- **`account-drain` `amountKobo` 4,500,000 → 12,000,000** (NGN 45,000 → 120,000).
  The old default cleared neither the "new payee, high amount" gate (~NGN
  50,000) nor "large amount, new device" (~NGN 100,000), the latter often a hard
  block — so the drain ran to completion against a system that would have
  stopped it.
- **Default withdrawal amounts in `buildWithdrawalPayload`** raised to NGN
  50,000–250,000. The old ceiling landed exactly on the common threshold, and
  those rules compare with `>`.
- **`credential-stuffing` reports `accountsTargeted`**.

### Fixed

- **`randomIp()` emitted unroutable addresses.** It generated across the whole
  IPv4 space, including private, loopback, CGNAT, link-local, multicast and
  documentation ranges. No IP-intelligence provider resolves those, so targets
  fell back to neutral intel and their proxy, abuse-score, new-country and
  impossible-travel rules silently scored zero — often four to six rules
  disabled without any error. Now restricted to publicly routable space.

### Added

- **`DEMO_IP_POOL` and `pickDemoIp()`** (exported from the package root) — a
  fixed pool of attacker IPs with declared geolocation, proxy/hosting flags and
  abuse scores, covering `domestic`, `hosting`, `proxy` and `foreign` personas.
  Most fraud systems resolve IP intel asynchronously and fall back to neutral
  values on a cache miss; in a short run every IP is new, so geo and reputation
  rules never fire. Because this pool is fixed and its metadata published, a
  target can pre-warm its cache from it — no live lookups, no third-party rate
  limits mid-demo, reproducible results. Addresses come from the RFC 5737
  documentation ranges, so a simulation never attributes attack traffic to a
  real network operator.
- **`ipPersona` option on `credential-stuffing`** — `random` (default,
  generated routable IPs), `mixed` (realistic botnet composition drawn from the
  pool), or a single persona to probe one rule family at a time.
- **`ipIntel` on `attempt` events** when a pool persona is used, so a dashboard
  can show why an IP is suspicious and a target can seed intel inline.
- 17 tests covering reserved-range exclusion, pool integrity, account spraying,
  persona filtering and back-compat (87 total, all passing).

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
