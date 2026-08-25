# Attack Patterns

This document describes each scenario `fraud-sim` ships, what real-world attack it models, and what defences should catch it.

---

## Available in v0.1

### credential-stuffing

**What it simulates:** A botnet attempts to authenticate against a target user account using credentials harvested from data breaches elsewhere. Each attempt comes from a different IP address with a rotating user agent string. Attempts are paced to evade naive rate limiting.

**Real-world reference:** Most fintech account takeover attacks start here. Breach data is cheap (often free), and any fintech with users who reuse passwords is a target.

**Default behaviour:**
- 50 distinct attacker IPs
- 3 attempts per IP before rotating
- 200ms between attempts
- 200 total attempts maximum (safety ceiling)
- Targets a single specified user

**Signals that should catch this:**
- `LOGIN_VELOCITY_USER` — many login attempts on one user account
- `LOGIN_VELOCITY_IP` — many login attempts from one IP
- `IP_PROXY_VPN` — datacenter or VPN IPs
- `IP_MANY_USERS` — one IP trying many user accounts (if the scenario is configured to attack multiple users)
- `NEW_DEVICE` — every attempt uses a different device fingerprint

**Realistic block rate against a well-tuned defender:** 85–95%

**Options:**

| Option | Default | Description |
|---|---|---|
| `targetUserId` | (required) | The user being attacked |
| `attackerCount` | 50 | Number of distinct attacker IPs |
| `attemptsPerIp` | 3 | Attempts before rotating to a new IP |
| `delayMs` | 200 | Pause between attempts |
| `maxTotalAttempts` | 200 | Hard ceiling — prevents runaway sims |

---

### account-drain

**What it simulates:** An attacker who has obtained valid credentials (via phishing, breach, or social engineering) logs in from a new device, immediately changes the password to lock out the legitimate user, then rapidly transfers funds to new payee accounts before detection.

**Real-world reference:** This is the highest-cost fraud pattern in African fintech — a single successful drain can wipe an account. SIM swap attacks typically end with this pattern.

**Default behaviour:**
1. Login from a new device using attacker's IP
2. Trigger a password change event (locks out the real user)
3. Wait 30 seconds (realistic attacker timing)
4. 5 rapid withdrawals of NGN 45,000 each to different new payees
5. 15 seconds between withdrawals

**Signals that should catch this:**
- `NEW_DEVICE` on login — first defence
- `WITHDRAWAL_AFTER_PWD_CHANGE` — withdrawal soon after password reset
- `DEVICE_SESSION_MISMATCH` — device changed mid-session
- `NEW_PAYEE_HIGH_AMOUNT` — first transaction to new payee, large amount
- `NEW_PAYEE_FIRST_TXN` — first ever transaction to this payee
- `DRAIN_PATTERN` — 3+ new payees within 30 minutes

**Realistic outcomes against a well-tuned defender:**
- Login: STEP_UP (NEW_DEVICE alone is rarely enough to BLOCK)
- First withdrawal: STEP_UP or BLOCK
- DRAIN_PATTERN typically fires by the third withdrawal at the latest
- Attacker should not succeed in fully draining the account

**Options:**

| Option | Default | Description |
|---|---|---|
| `targetUserId` | (required) | The user whose account is drained |
| `attackerIp` | random | Override the attacker's IP |
| `withdrawalCount` | 5 | Number of withdrawals to attempt |
| `amountKobo` | 4,500,000 | NGN 45,000 per withdrawal |
| `delayBetweenWithdrawalsMs` | 15,000 | 15 seconds between withdrawals |
| `postLoginPauseMs` | 30,000 | Wait between password change and first withdrawal |
| `skipPasswordChange` | false | Skip the password change step (useful for testing without that signal) |

---

## Planned for v0.2

### adaptive-attacker (LLM-driven)

**What it will simulate:** An attacker that observes which attempts are blocked and the reason codes returned, then uses an LLM to reason about what to change. Unlike scripted scenarios, the strategy evolves mid-attack.

The LLM sees only what a real attacker would: the decision (`ALLOW`/`STEP_UP`/`BLOCK`) and the reason codes. It cannot see the target's rule weights or thresholds.

**Why this matters:** Real attackers behave this way. A defender that catches scripted attacks but fails against an adaptive adversary has a false sense of security.

**Status:** Planned for v0.2.

---

## Planned for v0.3

The following scenarios are planned for v0.3. Implementation will start once v0.2 (the adaptive attacker) ships.

### promo-abuse

**What it will simulate:** One actor creating many accounts to farm signup bonuses and referral rewards. Same device fingerprint across accounts, same IP subnet, slightly varied user details.

**Signals that should catch this:** Device clustering across accounts, IP /24 clustering, referral graph anomalies.

### card-testing

**What it will simulate:** BIN attacks and micro-authorisation probing — attackers validating stolen card numbers by attempting tiny transactions before scaling up.

**Signals that should catch this:** Micro-auth velocity, BIN range velocity, CNP transaction patterns.

### sim-swap-takeover

**What it will simulate:** Phone number ported to attacker's SIM, OTP redirected, login from attacker's device, immediate withdrawal. Models the full SIM swap attack flow.

**Signals that should catch this:** Telco API check for recent porting, OTP-to-new-device detection, login-immediately-after-port heuristic.

### mule-network

**What it will simulate:** Coordinated transfers between accounts simulating fund laundering. Multiple "mule" accounts receive funds from one source, then forward to a final destination.

**Signals that should catch this:** Graph clustering of accounts by transaction patterns, ratio anomalies (high pass-through with low retention).

### slow-drain

**What it will simulate:** Withdrawals individually below the velocity threshold but collectively significant over a longer window. Tests for systems that only check short-term velocity.

**Signals that should catch this:** Multi-window velocity, baseline deviation, cumulative amount detection.

### session-hijack

**What it will simulate:** Mid-session device or IP change after a successful login. Models cookie theft and session hijacking attacks.

**Signals that should catch this:** Session continuity checks, device fingerprint at withdrawal vs login.

### velocity-evasion

**What it will simulate:** An attacker who has learned to space attempts just under any single velocity limit. Tests for adaptive thresholding and pattern detection beyond simple counters.

**Signals that should catch this:** Adaptive thresholds based on user baseline, statistical anomaly detection.

---

## Contributing a new scenario

See [CONTRIBUTING.md](../CONTRIBUTING.md) for the contribution process. The short version: open an issue describing the attack pattern first, get approval, then submit a PR using the existing scenarios as a template.
