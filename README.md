# fraud-sim

**Realistic synthetic attack traffic for testing fintech fraud detection systems.**

[![npm version](https://img.shields.io/npm/v/fraud-sim.svg)](https://www.npmjs.com/package/fraud-sim)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![tests](https://github.com/arthurr-beep/fraudsim/workflows/test/badge.svg)](https://github.com/arthurr-beep/fraudsim/actions)
[![lint](https://github.com/arthurr-beep/fraudsim/workflows/lint/badge.svg)](https://github.com/arthurr-beep/fraudsim/actions)
[![secret-scan](https://github.com/arthurr-beep/fraudsim/workflows/secret-scan/badge.svg)](https://github.com/arthurr-beep/fraudsim/actions)
[![node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)

`fraud-sim` is a target-agnostic library for generating realistic fraud attack traffic — credential stuffing, account takeovers, card testing, and LLM-driven adaptive attackers — against any fraud detection system you want to evaluate.

You build the defence. We bring the adversary.

```js
import { run, httpAdapter } from 'fraud-sim';

const target = httpAdapter({
  baseUrl: 'https://api.your-fraud-system.com',
  headers: { Authorization: `Bearer ${process.env.API_KEY}` },
});

const report = await run('credential-stuffing', {
  options: { targetUserIds: ['user_001', 'user_002', 'user_003'], attackerCount: 20 },
  target,
  onEvent: (event) => console.log(event.type, event),
});

console.log(`Blocked ${report.blocked} of ${report.attempts} attempts (${(report.blockRate * 100).toFixed(1)}%)`);
```

---

## Why this exists

Every team building fraud detection needs to answer one question: *does it actually work?*

The honest ways to find out are limited. You can wait for real attackers (expensive in losses, slow in feedback). You can write throwaway shell scripts (different per engineer, never reused, never reviewed). You can buy proprietary attack libraries from vendors (closed, locked to one product, often years out of date).

`fraud-sim` is the open alternative: a maintained, scenario-extensible library that any team can point at any target. Test your in-house rules engine. Benchmark Stripe Radar. Compare two vendors side by side. Run it in CI to catch regressions when you change a threshold.

It works against any HTTP API. It uses no real fraud data. It includes an LLM-powered adaptive attacker that learns from your blocks and changes strategy mid-attack — because real attackers do exactly that.

---

## What it does

- **10 attack scenarios** — credential stuffing, account drain, card testing, promo abuse, mule networks, slow drain, session hijack, SIM swap takeover, velocity evasion, and the LLM-driven adaptive attacker
- **Target-agnostic** — works against any REST API via a configurable adapter
- **LLM-driven adaptive attacker** — bring your own OpenAI, Anthropic, or local model. A deterministic fallback works without any LLM
- **Structured event stream** — every action emits a typed event. Pipe it to a dashboard, log it, or stream it via Server-Sent Events
- **Suite runs** — run several scenarios in one pass and get an aggregate block rate across them. Richer reporting (HTML, JUnit, side-by-side target comparison) is planned for v0.4
- **Safe by default** — an enforced ceiling of 25 requests/second, not just per-scenario pacing, so a mistyped delay stays a simulation

---

## What it doesn't do

- **It doesn't detect fraud.** It's the attacker, not the defender. You bring the detection system.
- **It doesn't ship with real fraud data.** Every payload is synthetic. No leaks, no licensing risks, no privacy concerns.
- **It isn't an attack tool.** Use it against systems you own or have written permission to test. The README will keep saying this.

---

## Install

```bash
npm install fraud-sim
```

Requires Node.js 20 or higher. Works with ESM and CommonJS.

---

## Test it safely first (no real system needed)

Everything can be exercised against targets that live entirely on your machine
before you ever point it at a production fraud system. Two shipped options:

**In-process mock — zero dependencies, no network.** Script the responses a
detection system would return and run a scenario against them:

```js
import { run } from 'fraud-sim';
import { mockAdapter } from 'fraud-sim/adapters';

const target = mockAdapter({
  scoreLogin: [{ decision: 'ALLOW' }, { decision: 'STEP_UP' }, { decision: 'BLOCK' }],
});
const report = await run('credential-stuffing', {
  target,
  options: { targetUserId: 'victim_001', attackerCount: 3, attemptsPerIp: 1 },
});
console.log(report); // { attempts, blocked, stepUp, allowed, blockRate, ... }
```

**Bundled mock HTTP target — a realistic practice range.** The package ships a
small Express server with an actual rules engine. Install `express` once
(`npm install express`), then:

```bash
npm run example:mock-target   # terminal 1 → http://localhost:4000
npm run example:basic         # terminal 2 → attacks it, watch decisions escalate
```

Graduating to the real thing is a one-line change — swap the `baseUrl`. Full
walk-through in **[docs/TESTING.md](docs/TESTING.md)**.

---

## Quickstart — 5 minutes from zero to your first simulation

### 1. Set up a target

Any HTTP API that takes a JSON payload and returns a decision. The simplest target is your own Express server returning `{ decision: 'ALLOW' }` for everything — useful for verifying the setup works before pointing at a real fraud system.

```js
// example-target.js
import express from 'express';
const app = express();
app.use(express.json());
app.post('/score/login', (req, res) => {
  res.json({ decision: 'ALLOW', risk_score: 0.1, reasons: [] });
});
app.listen(3000, () => console.log('Target listening on :3000'));
```

### 2. Run a simulation against it

```js
// run-sim.js
import { run, httpAdapter } from 'fraud-sim';

const target = httpAdapter({
  baseUrl: 'http://localhost:3000',
  endpoints: { scoreLogin: '/score/login' },
});

const report = await run('credential-stuffing', {
  options: {
    targetUserIds: Array.from({ length: 12 }, (_, i) => `test_user_${i}`),
    attackerCount: 10,
  },
  target,
  onEvent: (event) => {
    if (event.type === 'response') {
      console.log(`Attempt ${event.round}: ${event.response.decision} (${event.latencyMs}ms)`);
    }
  },
});

console.log('\nFinal report:', report);
```

```
Attempt 0: ALLOW (3ms)
Attempt 1: ALLOW (2ms)
Attempt 2: ALLOW (2ms)
...
Final report: { attempts: 30, blocked: 0, stepUp: 0, allowed: 30, blockRate: 0 }
```

The example target allows everything — block rate is 0%. Now point `httpAdapter` at your real fraud system and see what changes.

### 3. Try the LLM-driven adaptive attacker

```js
import { run, httpAdapter } from 'fraud-sim';
import { anthropic } from 'fraud-sim/llm';

const target = httpAdapter({
  baseUrl: 'https://api.your-fraud-system.com',
  headers: { Authorization: `Bearer ${process.env.API_KEY}` },
});

const llm = anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  model: 'claude-sonnet-4-20250514',
});

const report = await run('adaptive-attacker', {
  options: { targetUserId: 'test_user_001', maxRounds: 10 },
  target,
  llm,
  onEvent: (event) => {
    if (event.type === 'attacker_adapts') {
      console.log(`Round ${event.round}: ${event.reasoning}`);
    }
    if (event.type === 'response') {
      console.log(`  → ${event.response.decision} (${event.response.reasons?.map(r => r.code).join(', ')})`);
    }
  },
});

console.log(`\nOutcome: ${report.outcome}`);
console.log(`The attacker took ${report.rounds} rounds to ${report.outcome === 'attacker_defeated' ? 'give up' : 'succeed'}.`);
```

Don't have an LLM API key? Use the deterministic fallback — it runs without any external API and produces reproducible results:

```js
import { deterministic } from 'fraud-sim/llm';
const llm = deterministic({ seed: 42 });
```

---

## The scenarios

All ten are registered and runnable. `listScenarios()` returns the live list at
runtime.

| ID | Needs | What it simulates |
|---|---|---|
| `credential-stuffing` | login | A botnet replays a stolen credential dump across many IPs and many accounts |
| `account-drain` | login, withdrawal | Attacker logs in from a new device, changes the password, and rapidly drains funds to new payees |
| `adaptive-attacker` | login | An LLM-driven attacker that observes blocks and reason codes, then adapts its strategy |
| `card-testing` | action | BIN attacks and micro-authorisation probing, escalating to real charges on validated cards |
| `promo-abuse` | action | One actor creating many accounts to farm signup bonuses, reusing devices and subnets |
| `mule-network` | withdrawal | Fan-out to mule accounts, then fan-in to one destination — laundering by layering |
| `slow-drain` | withdrawal | Withdrawals individually below every short-window threshold, spread over days |
| `session-hijack` | login, action, withdrawal | A stolen session replayed from a different device and network |
| `sim-swap-takeover` | login, action, withdrawal | Number ported, OTP redirected, password reset, login, immediate withdrawal |
| `velocity-evasion` | login | An attacker pacing attempts to stay just under the rate limits |

The **Needs** column is the target methods each scenario calls: `login` is
`scoreLogin`, `withdrawal` is `scoreWithdrawal`, `action` is `scoreAction`. A
scenario throws a clear error if the adapter does not implement what it needs,
so a target that only scores logins and withdrawals can still run seven of the
ten.

Four scenarios (`slow-drain`, `velocity-evasion`, `mule-network`, and the timing
stages of `sim-swap-takeover`) advance the payload `timestamp` instead of
sleeping for hours, and set `simulatedTime: true` on the report. That is
faithful only if your system derives its velocity windows from the event
timestamp — if it stamps arrival time server-side, those runs measure a burst
rather than the attack they describe.

Each scenario has its own options and emits structured events you can subscribe to. See [`docs/ATTACK_PATTERNS.md`](docs/ATTACK_PATTERNS.md) for full details on each one.

List scenarios programmatically:

```js
import { listScenarios } from 'fraud-sim';
const scenarios = listScenarios(); // synchronous
// → [{ id: 'credential-stuffing', name: '...', description: '...', defaultOptions: {...} }, ...]
```

---

## The CLI

For quick experiments without writing code:

```bash
npx fraud-sim run credential-stuffing \
  --target https://api.your-fraud-system.com \
  --auth "Bearer $API_KEY" \
  --user user_001 \
  --attackers 50

# Run a full benchmark suite
npx fraud-sim suite owasp-baseline \
  --target https://api.your-fraud-system.com \
  --auth "Bearer $API_KEY" \
  --output report.html

# Compare two targets
npx fraud-sim compare \
  --target-a "https://api.system-a.com" \
  --target-b "https://api.system-b.com" \
  --suite owasp-baseline
```

---

## Calibrating a run

A simulation only tells you something if the attack actually crosses the
thresholds the target is configured with. Two failure modes look identical in a
report and mean opposite things:

- **The attack was caught.** Low allow rate, several distinct reason codes.
- **The attack was too quiet to catch.** Also a low block rate — but the
  defence never had anything to fire on.

Three settings decide which one you get.

**`targetUserIds` — how many accounts the dump covers.** Credential stuffing is
a list of victims, not one victim retried. Engines commonly ship a "one IP,
many users" rule with a limit near 10 accounts; pass fewer than that and the
rule cannot fire. The scenario emits a `milestone` warning if you pass a single
account.

**`attemptsPerIp` — how hard each IP pushes.** Per-IP velocity limits commonly
sit near 20 attempts per 5 minutes. The default of 25 clears that; the previous
default of 3 did not, so the rule stayed silent on every run.

**`ipPersona` — whether geo and reputation rules are reachable at all.** This is
the subtle one. Most fraud systems resolve IP intelligence *asynchronously* and
fall back to neutral values on a cache miss. In a short run every IP is seen for
the first time, so proxy, abuse-score, new-country, and impossible-travel rules
all score zero — often four to six of the target's rules, silently disabled.

```js
import { DEMO_IP_POOL } from 'fraud-sim';

// Before the run: seed the target's IP-intel cache from the pool.
for (const entry of DEMO_IP_POOL) {
  await yourSystem.cacheIpIntel(entry.ip, entry);
}

const report = await run('credential-stuffing', {
  target,
  options: { targetUserIds, ipPersona: 'mixed' },
});
```

`DEMO_IP_POOL` is a fixed set of addresses with declared geolocation and
reputation, drawn from the RFC 5737 documentation ranges so a simulation never
attributes attack traffic to a real network operator. Because it is fixed and
its metadata is published, the system under test can pre-warm from it — no live
lookups, no third-party rate limits mid-demo, and reproducible results.

| `ipPersona` | Draws from | Use when |
|---|---|---|
| `random` (default) | Generated public IPv4, no metadata | Pointing at a system that does its own live IP lookups |
| `mixed` | Hosting, proxy, foreign and domestic pool entries | Demos and CI — the realistic botnet composition |
| `domestic` | In-country residential | Isolating velocity rules from geo rules |
| `hosting` / `proxy` / `foreign` | That persona only | Probing one rule family at a time |

Note that `random` deliberately excludes private, loopback, CGNAT, link-local
and documentation ranges. Addresses in those blocks resolve at no IP-intel
provider, which produces the silent-neutral-fallback problem above.

Scenario events carry the intel alongside each attempt when a pool persona is
used, so a live dashboard can show *why* an IP is suspicious:

```js
onEvent: (e) => {
  if (e.type === 'attempt' && e.ipIntel) {
    console.log(e.payload.ip_address, e.ipIntel.countryCode, e.ipIntel.abuseScore);
  }
}
```

---

## The adaptive attacker — how it works

The `adaptive-attacker` scenario is `fraud-sim`'s headline feature, and the part that's worth understanding before using it.

In a normal scripted attack scenario, the attacker follows a predetermined sequence. The adaptive attacker instead observes how the target responds to each attempt and changes strategy.

```
Round 1: Attacker tries a standard login (residential IP, common user agent)
         Target responds: STEP_UP — reasons: ["NEW_DEVICE"]

Round 2: LLM reasons: "Device fingerprint was flagged — I should reuse the
         same fingerprint instead of generating a new one."
         Attacker tries again with consistent device.
         Target responds: STEP_UP — reasons: ["IP_PROXY_VPN"]

Round 3: LLM reasons: "IP is flagged as a proxy. Switching to a residential
         IP range."
         Attacker tries with a residential-looking IP.
         Target responds: BLOCK — reasons: ["LOGIN_VELOCITY_USER"]

Round 4: LLM reasons: "Velocity threshold hit. I'll wait and reduce my pace."
         Attacker waits 60 seconds, tries again with cleaner signals.
         Target responds: BLOCK — reasons: ["IP_MANY_USERS"]

...
```

**What the LLM sees:** the decision (`ALLOW`/`STEP_UP`/`BLOCK`), the reason codes (`NEW_DEVICE`, `IP_PROXY_VPN`, etc.), and the round number. Nothing else. It cannot see the target's rule weights, thresholds, or internal state.

**Why this matters:** real attackers operate this way. They probe, learn, and adapt. A fraud system that catches a one-shot attack but fails against an adaptive adversary is not actually well-defended. The adaptive attacker exposes the difference.

**Defensive systems that defeat the adaptive attacker do so because rules stack.** Defeating one signal exposes the next. A system with only one rule (say, IP reputation) can be evaded by changing IPs. A system with nine independent signals — velocity, device, geo, behaviour, payee, session continuity — cannot be evaded by changing any one of them.

The library ships with three LLM providers (OpenAI, Anthropic, and a deterministic fallback) and a clean interface for plugging in others — see `src/llm/`.

---

## Benchmarking and reporting

Run several scenarios in one pass and get a per-scenario breakdown plus an
aggregate across all of them:

```js
import { runSuite } from 'fraud-sim';

const result = await runSuite({
  name: 'monthly-benchmark',
  scenarios: [
    { id: 'credential-stuffing', options: { targetUserIds, attackerCount: 20 } },
    { id: 'account-drain',       options: { targetUserId: 'victim_001', withdrawalCount: 10 } },
    { id: 'adaptive-attacker',   options: { targetUserId: 'victim_001', maxRounds: 15 } },
  ],
  target,
});

console.log(result.aggregate);
// → { attempts, blocked, stepUp, allowed, blockRate, stepUpRate }

for (const r of result.scenarioReports) {
  console.log(r.scenarioId, r.blockRate);
}
```

Because the aggregate is a plain object, gating CI on it needs no extra
tooling — assert on the block rate and fail the build when a threshold change
makes the defence worse. Check `errorRate` first, or a target that was simply
unreachable will sail through the gate:

```js
const { blockRate, errorRate, scoredAttempts } = result.aggregate;

if (errorRate > 0.05) {
  throw new Error(
    `${(errorRate * 100).toFixed(1)}% of attempts never got a decision — ` +
      'the target was unhealthy, so this run says nothing about the defence.'
  );
}

if (blockRate < 0.85) {
  throw new Error(`Block rate regressed to ${blockRate} over ${scoredAttempts} scored attempts`);
}
```

**Planned for v0.4:** HTML and JUnit report generation, latency percentiles,
reason-code frequency, and side-by-side comparison of two targets. There is no
`generateReport()` export today.

---

## Reproducible runs

Pass a `seed` and the run replays choice for choice — same IPs, same devices,
same amounts, same ordering:

```js
const report = await run('credential-stuffing', {
  target,
  options: { targetUserIds },
  seed: 42,
});

console.log(report.seed); // 42
```

Two runs with the same seed produce identical payloads. Different seeds produce
different ones. An unseeded run has no `seed` field on its report, so a report
never implies reproducibility it does not have.

This matters in two places. In CI, an unseeded block rate drifts between builds
for reasons unrelated to your rules, so a threshold gate is either too loose to
catch regressions or flaky enough to be ignored. And when an attack does get
through, a seed is the difference between "something got past us" and a run you
can hand someone and replay exactly.

Seeding controls generated values, **not wall-clock time** — payload timestamps
still come from the real clock (or a scenario's simulated one), so two seeded
runs are identical in shape rather than byte-identical.

`runSuite` takes a seed too, deriving a distinct one per scenario so the suite
is reproducible as a whole without every scenario replaying the same values.

Custom scenarios get this for free as long as they draw randomness from
`fraud-sim/utils` rather than calling `Math.random()` directly.

---

## Rate limiting

Every run is capped at **25 outbound requests per second** by default, enforced
by wrapping the target adapter — so the ceiling holds for custom scenarios too,
not just the built-in ones. The shipped scenarios pace themselves well under it;
the cap exists so that a `delayMs: 0` typo against a real host stays a
simulation.

```js
await run('credential-stuffing', {
  target,
  options: { targetUserIds },
  maxRequestsPerSecond: 50,       // raise it deliberately
  // maxRequestsPerSecond: Infinity,  // or disable it entirely
});
```

If the cap actually held a run back, it emits a `warning` event saying by how
much — worth noticing before reading anything into that run's latency numbers.

---

## When the target misbehaves

A simulation is only a measurement if the target actually answered. `fraud-sim`
separates the two cases.

**Non-2xx responses are errors, not blocks.** If a `429` or a `503` were counted
as a `BLOCK`, then rate-limiting the simulator — or the target falling over
under load — would *raise* its measured block rate. A benchmark that rewards a
target for breaking is measuring the opposite of what it claims. So HTTP
failures come back as `decision: 'ERROR'` with `infraError: true` and a reason
code naming the cause (`RATE_LIMITED`, `SERVER_ERROR`, `AUTH_ERROR`,
`ENDPOINT_NOT_FOUND`, `NETWORK_ERROR`).

If your API genuinely signals a block with an HTTP status, say so explicitly:

```js
const target = httpAdapter({
  baseUrl: 'https://api.example.com',
  blockOnStatus: [403], // this API returns 403 for a hard block
});
```

**Rates are computed over attempts that were actually scored.** Every report
carries:

| Field | Meaning |
|---|---|
| `attempts` | Everything the scenario tried |
| `scoredAttempts` | Attempts that came back with a real decision (`attempts - errors`) |
| `errors` | Attempts that failed before being scored |
| `blockRate` | `blocked / scoredAttempts` |
| `stepUpRate` | `stepUp / scoredAttempts` |
| `errorRate` | `errors / attempts` |

A run with a non-zero `errorRate` also emits a `warning` event saying how much
of it failed. Treat a high `errorRate` as an invalid run, not a bad score.

---

## Unknown options are rejected

Each scenario's option surface is exactly its `defaultOptions`. Passing a key it
does not declare throws:

```js
await run('credential-stuffing', {
  target,
  options: { targetUserIds, attemptsPerIP: 25 }, // note the capital P
});
// Error: Unknown option for scenario "credential-stuffing": "attemptsPerIP"
//        (did you mean "attemptsPerIp"?). Valid options: attackerCount,
//        attemptsPerIp, delayMs, ipPersona, maxTotalAttempts, targetUserId,
//        targetUserIds.
```

Silently falling back to the default would produce a run that completes, looks
healthy, and answers a different question than the one you asked — the same
failure mode as an under-calibrated attack, just self-inflicted. Custom
scenarios registered without `defaultOptions` skip this check.

---

## Writing your own scenario

A scenario is a single file. Here's a minimal one:

```js
// my-custom-scenario.js
import {
  sleep,
  newResults,
  scoreAndCount,
  buildLoginPayload,
  randomIp,
  alphanumeric,
} from 'fraud-sim/utils';

export default {
  id: 'my-custom-attack',
  name: 'Account enumeration',
  description: 'Tries to enumerate valid accounts by varying the user, not the attacker',

  // The option surface. Anything not listed here is rejected at run time, so
  // a typo fails loudly instead of silently falling back to a default.
  defaultOptions: {
    attemptCount: 100,
    delayMs: 100,
  },

  async run(ctx) {
    const { options, emit, signal } = ctx;
    const results = newResults({ usersProbed: 0 });

    // One attacker, one device — the constants are the signal here.
    const attackerIp = randomIp();
    const device = `enum-bot-${alphanumeric(8)}`;

    emit({
      type: 'milestone',
      message: `Enumerating ${options.attemptCount} accounts from ${attackerIp}`,
      timestamp: Date.now(),
    });

    for (let i = 0; i < options.attemptCount && !signal.aborted; i++) {
      // scoreAndCount emits the attempt/response pair, updates the tally, and
      // reports a missing adapter method clearly.
      await scoreAndCount({
        ctx,
        method: 'scoreLogin',
        payload: buildLoginPayload(`probe_${alphanumeric(10)}@example.invalid`, {
          ip_address: attackerIp,
          device_fingerprint: device,
        }),
        results,
      });

      results.usersProbed++;

      try {
        await sleep(options.delayMs, signal);
      } catch {
        break; // aborted
      }
    }

    // The runner adds scenarioId, blockRate, errorRate and timings.
    return results;
  },
};
```

Two things the helpers buy you. `randomIp()` avoids private, loopback and
documentation ranges — a hardcoded `192.168.1.100` resolves at no IP-intel
provider, so the target falls back to neutral values and its geo and reputation
rules never fire, making your attack look harmless for the wrong reason. And
because every generator draws from the run's random source, your scenario
replays under `seed` like the built-in ones do.

Register it and run it:

```js
import { run, registerScenario } from 'fraud-sim';
import myScenario from './my-custom-scenario.js';

registerScenario(myScenario);
await run('my-custom-attack', { options: { attemptCount: 200 }, target });
```

The built-in scenarios in `src/scenarios/` are the reference — `slow-drain` is the simplest one that uses a simulated clock, and `mule-network` the simplest multi-stage one.

---

## Built-in adapters

```js
import { httpAdapter, mockAdapter, loggingAdapter, recordingAdapter } from 'fraud-sim/adapters';
```

- **`httpAdapter`** — sends events to a REST API. Configurable for any target's response shape via a `responseMap` function.
- **`mockAdapter`** — returns predetermined responses. Used for testing scenarios without a real target.
- **`loggingAdapter`** — logs payloads to console or file without sending anywhere. Used to inspect what a scenario produces before pointing at a real system.
- **`recordingAdapter`** — wraps another adapter and records all request/response pairs to disk. Useful for capturing real interactions to replay later in tests.

Write your own adapter to support non-HTTP targets (gRPC, message queues, internal function calls). See [`docs/TARGET_ADAPTERS.md`](docs/TARGET_ADAPTERS.md).

---

## Use it responsibly

This library generates traffic that looks like fraud, against systems that detect fraud. Use it only against systems you own or have explicit written permission to test.

- Do not point `fraud-sim` at any third-party API without authorisation. Doing so may violate computer-fraud laws in most jurisdictions.
- Do not use it as part of an actual attack on any system. The library is explicitly designed for testing your own defences and for vendors testing their own products.
- Do not use it to evade or attack real fintech production systems, including ones you have customer accounts with. Customer terms of service prohibit this.

The library caps outbound traffic at 25 requests per second by default, enforced in the runner rather than left to each scenario's pacing. That is not aggressive enough to support real attacks at scale, and raising it requires passing `maxRequestsPerSecond` explicitly. This is a feature, not a limitation.

If you find a way to use `fraud-sim` that the maintainers should consider out of scope, please open an issue.

---

## Roadmap

`fraud-sim` is built in phases. Each phase has a clear scope and a release.

| Version | Focus | Status |
|---|---|---|
| v0.1 | Core abstractions, 2 scenarios, HTTP adapter | ✅ Released |
| v0.2 | LLM-driven adaptive attacker, SSE streaming | ✅ Released (current) |
| v0.3 | 7 additional scenarios (library complete), CLI runner | ✅ Scenarios released; CLI next |
| v0.4 | Reporting (HTML/JUnit), latency percentiles, target comparison | Planned |
| v1.0 | Community scenario library, governance, stable API | Planned |

See [`CHANGELOG.md`](CHANGELOG.md) for what landed in each release.

---

## Contributing

Pull requests are welcome — especially new scenarios that cover attack patterns the library doesn't yet have. Read [`CONTRIBUTING.md`](CONTRIBUTING.md) before opening a PR.

Scenarios from real production attack patterns are especially valuable, but only if they have been fully anonymised and contain no real customer data. Synthetic scenarios that model a known attack class are also welcome.

If you've found a bug, open an issue with a minimal reproduction. If you have a feature idea, open a discussion first — not every idea fits the library's scope, and we'd rather discuss it before you spend time on a PR.

---

## Maintainers

`fraud-sim` is maintained by [Arthur (@arthurr-beep)](https://github.com/arthurr-beep). It is independent open source under the MIT license.

Why we built this: real fraud detection systems need real adversarial testing, and the existing tooling for fraud teams was either ad-hoc scripts or vendor-locked. We wanted a tool that worked for everyone, including against our own product. That's the version we shipped.

If you find this library useful, the best thing you can do is contribute a scenario you wish existed. The second best thing is to tell us how it's working — open an issue, post on social, or just star the repo so we know there's interest.

---

## License

MIT — see [`LICENSE`](LICENSE) for the full text.

You may use this library commercially, modify it, and distribute it. You may not hold the maintainers liable for any consequences of its use. Use it against systems you own or have permission to test.

---

## Citation

If you use `fraud-sim` in academic research, please cite it:

```bibtex
@software{fraud_sim,
  title = {fraud-sim: A library for adversarial testing of fintech fraud detection systems},
  author = {{FriskLayer maintainers and contributors}},
  year = {2025},
  url = {https://github.com/arthurr-beep/fraudsim},
  license = {MIT}
}
```
