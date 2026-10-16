# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **End-to-end walkthrough** (`test/e2e/walkthrough.e2e.js`). Starts both
  practice engines as real HTTP servers and drives the real CLI and library
  against them in six acts: a contained botnet, a defeated adaptive attacker, a
  smarter attacker finding the hardened engine's gap, customers getting
  through, the full suite gated on block rate and false positives, and an
  unreachable target exiting 3. `npm run demo` paces it for a screen recording
  and opens the HTML report; `npm run test:e2e` runs it flat out and is part of
  CI. Every act asserts what it shows.

### Fixed

- The terminal report no longer prints an empty attack table and a
  "TOTAL 0 events" line for a run that contained only legitimate traffic.

## [0.5.0] — False positives, markets, a harder target — 2026-10-16

The first npm release since 0.2.0. Versions 0.3.0 and 0.4.0 below were tagged
in this changelog but never published, so everything from them ships here.

### Added — the other half of the measurement

- **`legitimate-users` scenario.** Ordinary customers, not an attack: routine
  logins, a new phone, travel, payments to known payees and the occasional new
  one. Every block it receives is a false positive, every step-up is friction.
  Until now a defence that blocked everything scored a perfect run.

  Built so the simulator does not manufacture the false positives it reports:
  a warm-up gives each customer history before anything is measured (reported
  separately, excluded from the rates); each customer has their own home
  address, so users-per-IP rules cannot fire on crowding the simulator caused;
  sessions are spread across days on the event clock; customers only use
  browser user agents.
- **Reports keep the two halves apart.** Attack totals, block rates and
  `--fail-under` cover attack scenarios only. Legitimate traffic is summarised
  under `totals.legitimate` (`falsePositiveRate`, `frictionRate`,
  `customersBlocked`, `valueBlockedMinor`), in every format: its own table in
  the terminal, a customer-impact panel in HTML with the bar colours inverted,
  JUnit failures of type `FalsePositives`, and a high-severity finding that
  names the stages and reason codes doing the blocking. When those reasons are
  velocity rules on time-compressed traffic, the finding says the block may be
  the simulator's clock rather than the customer.
- **`--max-false-positives <rate>`** on the CLI: exit 1 when more than that
  share of customer events was blocked. Refused up front if the run contains no
  legitimate traffic, because the gate would otherwise pass on zero customers.
- Every report and `listScenarios()` entry now carries
  `traffic: 'attack' | 'legitimate'`. Custom scenarios may declare `traffic`;
  it defaults to `'attack'`.

### Fixed — the adaptive attacker could not replay a device

- The history given to the LLM recorded the parameters a strategy *asked for*,
  not the payload actually sent. Round 1 never names a fingerprint, so the model
  saw `null` and could never replay the device the defender had challenged —
  the exact gap the hardened practice target leaves for a smarter attacker.
  History and `strategyHistory` now record the IP, user agent and fingerprint
  that were sent.
- `parameters` was declared inside the round loop, so a key the strategy
  omitted was silently re-randomised every round instead of kept. Omitting a
  key now means "keep it".
- The OpenAI and Anthropic prompts now list the parameters the attacker
  controls and say that history shows exactly what was sent.

### Changed

- `suite --all` runs `legitimate-users` first, before any attack has burned
  shared state (blocked IPs, blocked devices) on the target.
- README no longer claims the library benchmarks third-party vendors such as
  Stripe Radar. It exercises the rules behind your own scoring API; synthetic
  payloads say little about a vendor's ML, device SDK or consortium data.

### Added — a target that makes the attacker work

- **Hardened example target** (`examples/express-hardened-target`, port 4001)
  and a contrast demo (`npm run example:adaptive-hardened`) that runs the same
  scenario, at the same seed, against both practice targets.

  The reason it exists: against the simple target the adaptive attacker wins on
  move one and never adapts, so the artifact that is supposed to demonstrate
  adaptation demonstrates nothing. The honest fix was a target worth attacking,
  not a scenario rewritten to look busy — the scenario already adapts correctly
  when something pushes back.

  Its central rule is that an unrecognised device is never allowed outright,
  only challenged, which is what defeats an attacker whose entire strategy is
  rotation: rotating *creates* the unrecognised device. It also leaves one
  deliberate gap — a device that was merely challenged is remembered as seen,
  not as bad — so a smarter attacker beats it and the shipped deterministic one
  does not. That asymmetry is the point.

### Added — markets (breaking)

fraud-sim is a global tool now, not a Nigerian one with global reporting.

- **Locale packs** (`src/locales/`) supplying account-number and phone formats,
  bank names, personal names, payload currency, and the cities that count as
  domestic for geo rules. `NG`, `US`, `GB` and `KE` ship; adding one is a pull
  request against a single file.
- **`locale` option** on `run()` and `runSuite()`, and `--locale` on the CLI.
  Scoped with `AsyncLocalStorage` like the random source, so no generator needed
  a new argument and concurrent runs in different markets stay independent.
  Reports default to the market's own currency.
- Format is not cosmetic: a target that validates account numbers rejects a
  wrongly-shaped one before scoring it, so a mis-marketed run measures nothing.
  An unknown market code therefore throws instead of falling back.
- `demoIpPool()` returns the IP pool for the market in scope. "Domestic" is
  relative — Lagos is the quiet baseline for a Nigerian bank and a new-country
  signal for a British one — so a fixed pool meant opposite things per target.
  `DEMO_IP_POOL` remains exported as the default market's snapshot.

### Changed — breaking

- **The default market is `US`.** Previously every payload was Nigerian with no
  way to say otherwise. Runs that want the old behaviour should pass
  `locale: 'NG'`.
- **Amount options renamed** from `*Kobo` to `*Minor`: `amountMinor`,
  `amountJitterMinor`, `amountPerMuleMinor`, `microAmountMinor`,
  `largeAmountMinor`, `bonusMinor`. The values are unchanged — they were always
  minor-unit integers, and kobo and cents are structurally identical. The old
  names still work and emit a deprecation warning, because the option validator
  rejects undeclared keys and a bare rename would have been a hard break.
- Report fields follow the same rename: `drainedMinor`, `totalMovedMinor`,
  `reachedDestinationMinor`. `estimatedLossKobo` is still accepted and still
  emitted alongside `estimatedLossMinor`.

### Added — report currency

- **`currency` and `locale` options** on `generateReport()` and `--currency` /
  `--locale` on the CLI. Amounts were always minor-unit integers — kobo and
  cents are structurally identical — so only presentation was ever bound to
  naira. Nothing is converted: the integers are untouched and only the symbol
  and grouping change, because a report that silently applied an FX rate would
  be wrong the moment the rate moved.
- The minor-unit exponent is read from `Intl` rather than assumed to be 2, so
  zero-decimal currencies are not divided by a hundred. The same integer that
  reads `₦606,000` correctly reads `￥60,600,000`.
- `estimatedLossMinor` is now the canonical report field; `estimatedLossKobo`
  keeps working for callers already written against it.

### Fixed

- **Seeded runs of `adaptive-attacker` ignored the seed.** The fallback provider
  was constructed with a hardcoded `seed: 42`, so every seeded run produced an
  identical strategy sequence no matter what the caller passed — in the one
  scenario whose value is that the attack varies. The provider seed now derives
  from the run's random source: reproducible under a seed, different across
  seeds.
- **The deterministic attacker described the wrong signal.** A rotating attacker
  sees `NEW_DEVICE` on every response because rotating is what creates it, and
  device signals were classified ahead of IP ones — so the attacker announced it
  was changing fingerprint while the address was what blocked it. IP is now
  ranked above device, being the part it can actually change for the better.
- **A step-up was reported as a block** in the attacker's reasoning. That text is
  read by a human in a report, and an attacker that mis-describes what just
  happened does not read as reasoning.

## [0.4.0] — CLI, reporting, concurrency — 2026-08-29

### Added — command line

- **`fraud-sim` CLI** (`npx fraud-sim`) with `list`, `run` and `suite`.
  Gates CI without writing JavaScript. Exit codes separate a weak defence (1)
  from an unmeasurable run (3), because a pipeline that reports an unreachable
  staging box as a security failure sends people to debug the wrong system.
- `suite --all` synthesises the account identifiers each scenario requires,
  giving every scenario a disjoint block so they do not contaminate each other's
  per-user counters. `--option key=value` applies to every scenario that
  declares that key; `--option <scenario>.key=value` targets one.
- `--fail-under` gates the **overall** block rate; `--fail-under-each` gates
  every scenario individually. The split matters: some scenarios include the
  victim's own legitimate traffic, so a low block rate there is correct, and a
  naive per-scenario floor produces false failures.
- Distinct error causes are surfaced during a run, deduplicated. Previously a
  broken target reported "100% failed" without saying why.
- **MSYS path-mangling guard.** Git Bash rewrites `--endpoint-login /score/login`
  into `C:/Program Files/Git/score/login`, so every request 404s and the run
  blames the target. Detected during development of this release; the CLI now
  names the cause and the fix instead.

### Added — reporting

- **`generateReport(result, { format })`** in `fraud-sim/reporting`, with
  `html`, `junit`, `json` and `text` formats, plus `summarise()` for asserting
  on a run without parsing a document.
- The HTML report is a standalone, printable document: findings ranked by cost,
  per-scenario decision bars, reason-code frequency, latency, and a limits
  section stating what the run cannot tell you. Decision colours are fixed
  status hues with the count always beside the bar, so colour is never the sole
  carrier.
- **JUnit is scored from the defender's side.** A blocked attack passes; a
  failure means the attack succeeded or nothing was blocked; an unreliable
  target is an `error`; a timing-dependent result is `skipped`, never a pass.
- Every report reads its numbers from one aggregation module, so no two formats
  can disagree. Totals are recomputed from counts rather than trusting a stored
  rate.

### Added — concurrency

- **`runSuite({ concurrency })`** runs scenarios in parallel, preserving input
  order in the results. The rate ceiling is shared across the whole suite: a
  limiter per run would have let the effective ceiling scale with the
  concurrency, which is the opposite of what a ceiling is for. Seeding stays
  correct under parallelism because the random source is scoped with
  `AsyncLocalStorage` rather than a module global.
- Sequential remains the default, and the docs say why: scenarios sharing a
  target interleave, so a parallel suite measures a combined attack rather than
  each attack independently.

### Added — metrics

- Every report now carries **latency percentiles** (nearest-rank, so each figure
  is a latency that actually occurred) and **reason-code frequency**, collected
  by the runner off the event stream so no scenario can forget to report them.

### Changed

- A scenario where nothing was blocked is now classified as "never blocked" even
  when it also carries a timing caveat — filing that as a methodology footnote
  buried the headline.

### Tests

- 31 new (180 total): outcome ranking, aggregation invariants, HTML and XML
  escaping of untrusted scenario ids and reason codes, the JUnit state mapping,
  gate scoping, concurrency overlap, order preservation, seeded reproducibility
  under concurrency, and a check that the shared ceiling holds at 1× and 4×
  concurrency.

## [0.3.0] — Complete scenario library, reproducible runs — 2026-08-29

Ten scenarios, seeded replay, an enforced rate ceiling, bundled TypeScript
declarations, and two fixes to how results are measured. **Read the breaking
notes before upgrading:** HTTP failures no longer count as blocks, unknown
scenario options are now rejected, and several attack defaults were retuned to
actually cross common rule thresholds.

### Added — TypeScript declarations

- **Types ship with the package.** Declarations are generated from the existing
  JSDoc by `npm run build:types` and wired into every export subpath, so
  `fraud-sim`, `/adapters`, `/llm`, `/streaming` and `/utils` all resolve with
  full autocomplete. No `@types` package needed.
- **`src/types.js`** defines the public shapes (`ScenarioReport`,
  `TargetAdapter`, `ScenarioEvent`, `Scenario`, `SuiteReport` and friends) as
  JSDoc typedefs. These names were already referenced throughout the codebase
  but never defined, so the generated declarations previously failed to compile
  with four `TS2304: Cannot find name` errors.
- **`prepublishOnly`** rebuilds declarations and runs lint plus the full test
  suite, so a release cannot ship stale types or a failing suite.

### Fixed

- **The README claimed CommonJS support the package does not have.** It is
  ESM-only; `require('fraud-sim')` throws `ERR_REQUIRE_ESM`. The install
  section now says so and documents the dynamic-import workaround.


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
