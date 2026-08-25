# Testing fraud-sim safely

Before you ever point `fraud-sim` at a real fraud-detection system, you can
exercise everything against targets that live entirely on your own machine.
There is nothing to sign up for and no traffic leaves your laptop.

There are three self-contained ways to run it, from zero-dependency to fully
realistic. Start at the top.

---

## 1. In-process mock — no server, no network (recommended first run)

The `mockAdapter` returns a scripted sequence of responses. Your attack scenario
runs against it in the same process, so there are no ports, no HTTP, and no extra
installs. This is exactly what the unit tests use.

```js
// try-it.mjs
import { run } from 'fraud-sim';
import { mockAdapter } from 'fraud-sim/adapters';

const target = mockAdapter({
  // Each login attempt pops the next response; the last one repeats.
  scoreLogin: [
    { decision: 'ALLOW' },
    { decision: 'STEP_UP', riskScore: 0.5 },
    { decision: 'BLOCK', riskScore: 0.9, reasons: [{ code: 'NEW_DEVICE' }] },
  ],
});

const report = await run('credential-stuffing', {
  target,
  options: { targetUserId: 'victim_001', attackerCount: 3, attemptsPerIp: 1, delayMs: 0 },
});

console.log(report);                       // { attempts, blocked, stepUp, allowed, blockRate, ... }
console.log(target._calls('scoreLogin'));  // every payload your scenario sent
```

```bash
node try-it.mjs
```

Use this to assert on behaviour in your own test suite — feed the adapter the
responses your real system *would* give and check that the scenario reacts
correctly. `_calls(endpoint)` and `_reportedEvents()` let you inspect exactly
what was sent.

---

## 2. Bundled mock HTTP target — realistic, over the wire

For a more lifelike run, the package ships a small Express server that implements
an actual rules engine (login velocity, new-device, new-payee, account-drain
patterns). Your scenario reaches it over HTTP via the `httpAdapter`, the same way
it will reach your real system — only the URL differs.

The mock server uses Express, which ships as a **dev dependency**, so install it
once if you don't already have it:

```bash
npm install express
```

Then, from the installed package (or a clone of the repo):

```bash
# Terminal 1 — start the mock fraud target on http://localhost:4000
npm run example:mock-target

# Terminal 2 — launch an attack against it
npm run example:basic       # credential stuffing
npm run example:drain       # account drain
```

You'll see each attempt escalate ALLOW → STEP_UP → BLOCK as the mock's risk
score climbs, followed by a summary report. This is the "practice range": get a
feel for the output and confirm your integration works before switching the URL.

Point your own script at it directly:

```js
import { run } from 'fraud-sim';
import { httpAdapter } from 'fraud-sim/adapters';

const target = httpAdapter({
  baseUrl: process.env.TARGET_URL ?? 'http://localhost:4000',
  endpoints: { scoreLogin: '/score/login', scoreWithdrawal: '/score/withdrawal' },
});

await run('credential-stuffing', { target, options: { targetUserId: 'victim_001' } });
```

> The mock at `examples/express-mock-target/server.js` is a stripped-down teaching
> example, **not** a real detection product. Its rules exist only to produce
> meaningful block rates in demos.

---

## 3. Adaptive attacker demo (optional, LLM-driven)

```bash
npm run example:adaptive-target   # terminal 1
npm run example:adaptive          # terminal 2
```

By default this runs a deterministic (no-API-key) attacker. To drive it with a
real model, set `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`; it falls back to the
deterministic strategy when no key is present, so it stays self-contained.

---

## Running the package's own test suite

If you cloned the repo:

```bash
npm test               # unit tests (in-process mock)
npm run test:integration   # end-to-end against the mock target
npm run test:all
```

---

## Graduating to a real target

Once the demos look right, the **only** change is the adapter configuration —
swap the local `baseUrl` for your real base URL and map your endpoints:

```js
const target = httpAdapter({
  baseUrl: 'https://fraud-api.internal.example.com',
  endpoints: { scoreLogin: '/v1/score/login', scoreWithdrawal: '/v1/score/withdrawal' },
  headers: { Authorization: `Bearer ${process.env.FRAUD_API_TOKEN}` },
});
```

Only run against systems you own or are explicitly authorized to test. See
[`../SECURITY.md`](../SECURITY.md) and the responsible-use notes in the README.
