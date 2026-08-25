# Security Policy

## Reporting a vulnerability

`fraud-sim` is a tool that generates adversarial traffic against fraud detection systems. By design, the output of the library looks like attack traffic. We need to be precise about what counts as a "security issue."

### What counts as a security issue

- A bug that causes `fraud-sim` to send traffic users did not authorise (e.g., a default that points at production systems, leakage of credentials)
- A vulnerability that allows malicious code to execute when a user runs `fraud-sim` (e.g., dependency vulnerabilities, prototype pollution, unsafe deserialisation)
- A defect in safety defaults that meaningfully increases the risk of accidental misuse
- A vulnerability in the LLM provider integration that exposes API keys or sensitive data

### What does NOT count as a security issue

- The library generates traffic that bypasses some specific fraud detection rule. That is the point. If your fraud system has a gap, that is a finding about your fraud system, not about `fraud-sim`.
- Someone could theoretically modify the library to use it offensively. We do not consider modifiability a vulnerability.

## Disclosure process

Please email arthurraugustus@gmail.com with:

- A description of the issue
- Steps to reproduce
- Affected versions
- Your assessment of impact

We aim to acknowledge reports within 72 hours. Coordinated disclosure timelines depend on severity.

Do NOT open public GitHub issues for security reports.

## Supported versions

| Version | Supported |
|---------|-----------|
| 0.1.x   | ✅ Active development |
| < 0.1.0 | ❌ Pre-release, not supported |

## Responsible use

This library is intended for testing fraud detection systems you own or have explicit written permission to test. Using it against systems you do not own or have permission to test may violate computer fraud laws in most jurisdictions.

The maintainers will not provide support, advice, or assistance to anyone using the library for unauthorised testing.
