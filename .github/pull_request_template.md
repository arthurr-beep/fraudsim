## What and why

<!-- What changes, and the problem it solves. Link the issue or discussion if there is one. -->

## Checklist

- [ ] `npm run lint` and `npm run test:all` pass
- [ ] `CHANGELOG.md` has an entry under **Unreleased** (skip for docs-only or CI-only changes)
- [ ] Public API or CLI changes are reflected in the README and JSDoc (`npm run test:types` checks the README examples)

### New or changed scenario

- [ ] The comment block at the top says which real attack pattern it models and which defences should catch it
- [ ] Every payload is synthetic: no real customer data, credentials, card numbers or IPs taken from production logs
- [ ] `docs/ATTACK_PATTERNS.md` describes it
- [ ] Tests cover the attack against both a target that stops it and one that does not
