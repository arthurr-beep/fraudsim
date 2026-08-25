# Adaptive attacker demo

Runs the `adaptive-attacker` scenario against a small local target that blocks
the attacker's opening move, so you can watch it adapt and break through.

## Run it

Two terminals.

**Terminal 1 — start the demo target:**

```bash
npm run example:adaptive-target
```

It listens on `http://localhost:4100`.

**Terminal 2 — run the attacker:**

```bash
npm run example:adaptive
```

By default this uses the **deterministic** (no-API) provider, so it needs no
API key and produces the same result every run. To drive it with a real LLM,
set an API key first:

```bash
OPENAI_API_KEY=sk-...        npm run example:adaptive
# or
ANTHROPIC_API_KEY=sk-ant-... npm run example:adaptive
```

## What you'll see

```
Round 1  Baseline attempt: residential-looking IP with a common browser user agent.
         ip=197.211.62.14  device=(generated)…
         → BLOCK   score 0.90  IP_REPUTATION, NEW_DEVICE

Round 2  Last attempt was blocked … Rotating the device fingerprint and user agent.
         ip=213.40.21.204  device=NEGxLVra8ZZa…
         → ALLOW   score 0.20  NEW_DEVICE

  Outcome: attacker_succeeded  (rounds: 2)
```

Round 1's baseline IP is on the target's reputation blocklist, so it's blocked.
The attacker sees the block reasons, rotates everything, and round 2 gets
through — because the target scores each attempt in isolation and can't tell a
freshly-rotated login from a legitimate one. That weakness is the point: it's
what a per-request defense misses and what the scenario is built to surface.

## Notes

- The target needs a moment to start listening. If terminal 2 shows
  `NETWORK_ERROR` on the first rounds, the target wasn't up yet — start it
  first and give it a second.
- The demo target (`demo-target.js`) is intentionally naive. Make its rules
  stricter (track IP /24 reuse, correlate device + IP, add step-up friction)
  and re-run to see the attacker take more rounds — or get defeated.
