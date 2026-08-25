# Contributing to fraud-sim

Thank you for considering a contribution. This document explains how to propose changes, what kinds of contributions are most valuable, and how to get a pull request merged.

## TL;DR

- Open an issue before starting significant work — saves wasted effort
- Run `npm test` before submitting a PR — all tests must pass
- New scenarios are the most welcome contribution — see "Adding a scenario" below
- Be patient with reviews — this project is maintained alongside full-time work

---

## Code of conduct

This project follows the [Contributor Covenant](https://www.contributor-covenant.org/version/2/1/code_of_conduct/). In short: be respectful, assume good faith, and focus on the work.

---

## Setting up locally

```bash
git clone https://github.com/frisklayer/fraud-sim.git
cd fraud-sim
npm install
npm test
```

You should see all tests pass in under a few seconds. If they don't on your machine, open an issue with your Node version and OS.

---

## Project structure

```
src/                     The library source
├── index.js             Public API surface
├── runner.js            Scenario orchestrator
├── scenarios/           Attack scenarios (each is one file)
├── adapters/            Target adapters (HTTP, mock, logging)
└── utils/               Shared utilities
test/
├── unit/                Fast, no I/O
└── integration/         Runs against a local HTTP server
examples/                Runnable examples
docs/                    Long-form documentation
```

---

## Adding a scenario

New scenarios are the highest-value contribution. The library is built around the idea that the scenario library grows with the community.

### What makes a good scenario

A good scenario:

- **Models a real-world attack pattern.** Not hypothetical — something that actually happens against fintechs.
- **Documents what defences should catch it.** The comment block at the top should list which rules or controls would detect this attack.
- **Has tunable difficulty.** Default options should produce a realistic challenge; advanced options should let users dial it up or down.
- **Respects safety limits.** A `maxTotalAttempts` ceiling, sensible default delays, no infinite loops.
- **Uses only synthetic data.** Never include real account numbers, real fraud patterns from production systems, or anything traceable to a real customer.

### What a scenario file looks like

A scenario is a single ES module file in `src/scenarios/`. See `credential-stuffing.js` for the canonical template. Required exports:

```js
export default {
  id: 'unique-kebab-case-id',
  name: 'Human-readable name',
  description: 'One-sentence description of what this simulates',
  defaultOptions: { /* sensible defaults */ },
  async run(ctx) {
    // ctx = { options, target, emit, signal, llm? }
    // Return { attempts, blocked, stepUp, allowed, ...custom fields }
  },
};
```

### Process for adding a scenario

1. Open an issue describing the attack pattern. Include: what real-world attack it models, why existing scenarios don't cover it, what defences should catch it.
2. Wait for maintainer approval before writing code. We may suggest changes to the design or reject ideas that don't fit the scope.
3. Implement the scenario following the existing files as a template.
4. Add unit tests in `test/unit/scenarios.test.js` covering the scenario's core behaviour.
5. Add an entry to `src/scenarios/index.js` to register it.
6. Update `docs/ATTACK_PATTERNS.md` with a description.
7. Submit a PR referencing the issue.

---

## Other contributions

### Bug fixes

Open an issue first with a minimal reproduction. PRs without an issue may be closed without review.

### Documentation

Documentation improvements are always welcome. Spelling, clarity, examples, additional reference docs — all valuable.

### New adapters

The library ships HTTP, mock, and logging adapters. New adapters (for non-HTTP targets like gRPC, message queues, internal function calls) are welcome but should be discussed in an issue first.

### LLM providers

Phase 2 of the library will add the adaptive attacker and a pluggable LLM provider interface. Until then, LLM provider contributions are premature.

---

## What we won't accept

To keep the library safe, useful, and focused, we reject contributions that:

- **Add real fraud data**, even anonymised. The library uses synthetic data exclusively.
- **Add detection logic.** This is a simulation library, not a detection library.
- **Add load testing features** (high-throughput, distributed execution). Use k6 or Artillery for that.
- **Add evasion of bot protection** (Cloudflare bypass, CAPTCHA solving, browser automation). These cross from "testing your own system" into "attacking other systems."
- **Are FriskLayer-specific.** The library must remain target-agnostic. Even though FriskLayer maintains it, contributions that only benefit FriskLayer will be declined.
- **Break the public API** without a clear migration path and a major version bump.

---

## Pull request checklist

Before submitting:

- [ ] Tests pass: `npm test`
- [ ] New code has new tests
- [ ] Documentation updated if behaviour changed
- [ ] `CHANGELOG.md` has an entry under `Unreleased`
- [ ] PR description references the issue that approved this work
- [ ] No real data, no detection logic, no scope creep

---

## Review process

- All PRs require a review from a maintainer
- We aim to respond to PRs within one week, but maintainership is alongside other commitments
- Reviews focus on: correctness, scope, safety, and consistency with existing code style
- We may ask for changes — please don't take this personally

---

## Security

If you discover a security issue (in the library itself, not in scenarios — those simulate attacks by design), please email the maintainers privately rather than opening a public issue. Contact details are in `SECURITY.md`.

---

## Release process

We use semantic versioning:

- **Patch** (0.1.x): Bug fixes, documentation
- **Minor** (0.x.0): New scenarios, new features that don't break the API
- **Major** (x.0.0): Breaking API changes (rare; will be 1.0.0 when the API stabilises)

---

Thank you for contributing. The project gets better with every scenario, every fix, and every clarification of the docs.
