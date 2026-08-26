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
  options: { targetUserId: 'user_001', attackerCount: 50 },
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

- **9 attack scenarios out of the box** — credential stuffing, account drain, card testing, promo abuse, mule networks, slow drain, session hijack, SIM swap takeover, and the adaptive LLM attacker
- **Target-agnostic** — works against any REST API via a configurable adapter
- **LLM-driven adaptive attacker** — bring your own OpenAI, Anthropic, or local model. A deterministic fallback works without any LLM
- **Structured event stream** — every action emits a typed event. Pipe it to a dashboard, log it, or stream it via Server-Sent Events
- **Benchmarking and reporting** — run scenarios as a suite, compare two systems, generate shareable HTML reports, integrate with CI
- **Safe by default** — modest attack rates that won't accidentally DDoS your own staging environment

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
  options: { targetUserId: 'test_user_001', attackerCount: 10 },
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

| ID | What it simulates |
|---|---|
| `credential-stuffing` | A botnet authenticates using stolen credentials across many IPs and rotating user agents |
| `account-drain` | Attacker logs in from a new device, changes the password, and rapidly drains funds to new payees |
| `adaptive-attacker` | An LLM-driven attacker that observes blocks and reason codes, then adapts its strategy |
| `card-testing` | BIN attacks, micro-authorisation probing, and automated card validation patterns |
| `promo-abuse` | One actor creating many accounts to farm signup bonuses and referral rewards |
| `mule-network` | Coordinated transfers between accounts simulating fund laundering |
| `slow-drain` | Withdrawals individually below the velocity threshold but collectively significant |
| `session-hijack` | Mid-session device or IP changes simulating session takeover |
| `sim-swap-takeover` | Phone number ported, OTP redirected, login from new device, immediate withdrawal |

Each scenario has its own options and emits structured events you can subscribe to. See [`docs/ATTACK_PATTERNS.md`](docs/ATTACK_PATTERNS.md) for full details on each one.

List scenarios programmatically:

```js
import { listScenarios } from 'fraud-sim';
const scenarios = await listScenarios();
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

The library ships with three LLM providers (OpenAI, Anthropic, and a deterministic fallback) and a clean interface for plugging in others. See [`docs/LLM_PROVIDERS.md`](docs/LLM_PROVIDERS.md).

---

## Benchmarking and reporting

Run a suite of scenarios and generate a shareable report:

```js
import { runSuite, generateReport } from 'fraud-sim';
import fs from 'node:fs';

const result = await runSuite({
  name: 'monthly-benchmark',
  scenarios: [
    { id: 'credential-stuffing', options: { attackerCount: 100 } },
    { id: 'account-drain',       options: { withdrawalCount: 10 } },
    { id: 'card-testing',        options: { cardCount: 50 } },
    { id: 'adaptive-attacker',   options: { maxRounds: 15 }, llm },
  ],
  target,
});

const html = await generateReport(result, { format: 'html' });
fs.writeFileSync('benchmark-report.html', html);
```

The HTML report includes:

- Block rate per scenario with confidence intervals
- Latency p50, p95, p99 across all attempts
- Reason code frequency (what's catching the most attacks)
- Side-by-side comparison when two targets are tested
- A timeline view of the adaptive attacker's reasoning

For CI integration, generate JUnit XML and feed it to GitHub Actions, GitLab CI, or Jenkins:

```js
const xml = await generateReport(result, { format: 'junit' });
fs.writeFileSync('fraud-sim-results.xml', xml);
```

A worked GitHub Actions example lives in [`examples/ci-integration-github-actions/`](examples/ci-integration-github-actions/).

---

## Writing your own scenario

A scenario is a single file. Here's a minimal one:

```js
// my-custom-scenario.js
import { faker } from '@faker-js/faker';

export default {
  id: 'my-custom-attack',
  name: 'Account enumeration',
  description: 'Tries to enumerate valid user accounts by varying the email',

  defaultOptions: {
    attemptCount: 100,
    delayMs: 100,
  },

  async run({ options, target, emit, signal }) {
    const opts = { ...this.defaultOptions, ...options };
    const results = { attempts: 0, blocked: 0, stepUp: 0, allowed: 0 };

    for (let i = 0; i < opts.attemptCount && !signal.aborted; i++) {
      const payload = {
        user_id: faker.internet.email(),     // varying the user, not the attacker
        ip_address: '192.168.1.100',         // same IP — this is the key signal
        device_fingerprint: 'enum-bot-001',
        timestamp: new Date().toISOString(),
        metadata: { _simulated: true },
      };

      emit({ type: 'attempt', round: i, payload, timestamp: Date.now() });
      const t0 = Date.now();
      const response = await target.scoreLogin(payload);
      emit({ type: 'response', round: i, response, latencyMs: Date.now() - t0, timestamp: Date.now() });

      results.attempts++;
      if (response.decision === 'BLOCK')   results.blocked++;
      if (response.decision === 'STEP_UP') results.stepUp++;
      if (response.decision === 'ALLOW')   results.allowed++;

      await new Promise(r => setTimeout(r, opts.delayMs));
    }

    return { scenarioId: this.id, ...results, blockRate: results.blocked / results.attempts };
  },
};
```

Register it and run it:

```js
import { run, registerScenario } from 'fraud-sim';
import myScenario from './my-custom-scenario.js';

registerScenario(myScenario);
await run('my-custom-attack', { options: { attemptCount: 200 }, target });
```

Full guide: [`docs/EXTENDING.md`](docs/EXTENDING.md).

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

Default rate limits in the library (modest attack counts, 200ms delays between actions) are deliberate. They are not aggressive enough to support real attacks at scale, and aggressive configurations require explicit setup. This is a feature, not a limitation.

If you find a way to use `fraud-sim` that the maintainers should consider out of scope, please open an issue.

---

## Roadmap

`fraud-sim` is built in phases. Each phase has a clear scope and a release.

| Version | Focus | Status |
|---|---|---|
| v0.1 | Core abstractions, 2 scenarios, HTTP adapter | 🚧 In development |
| v0.2 | LLM-driven adaptive attacker, SSE streaming | Planned |
| v0.3 | 7 additional scenarios, CLI runner | Planned |
| v0.4 | Test suites, reporting, benchmarking, CI integration | Planned |
| v1.0 | Community scenario library, governance, stable API | Planned |

Full phase plan in [`docs/ROADMAP.md`](docs/ROADMAP.md).

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
