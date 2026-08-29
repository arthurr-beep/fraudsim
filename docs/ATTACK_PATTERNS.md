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
| `targetUserIds` | (required) | The accounts in the stolen dump. Must exceed the target's "one IP, many users" limit (commonly 10) for that rule to fire |
| `targetUserId` | — | Back-compat: a single account, equivalent to `targetUserIds: [id]` |
| `attackerCount` | 20 | Number of distinct attacker IPs |
| `attemptsPerIp` | 25 | Attempts before rotating to a new IP. Must exceed the target's per-IP velocity limit (commonly 20 per 5 min) for that rule to fire |
| `delayMs` | 100 | Pause between attempts |
| `maxTotalAttempts` | 500 | Hard ceiling — prevents runaway sims |
| `ipPersona` | `'random'` | `random` \| `mixed` \| `domestic` \| `hosting` \| `proxy` \| `foreign`. Anything other than `random` draws from `DEMO_IP_POOL`, whose declared geo/reputation the target can pre-seed so its geo rules are reachable |

**Report fields:** the standard `attempts` / `blocked` / `stepUp` / `allowed` /
`blockRate`, plus `accountsTargeted` (how many distinct accounts were hit).

> **Calibration.** The v0.2 defaults (`attemptsPerIp: 3`, one account, and
> randomly generated IPs including unroutable ranges) sat below the thresholds
> most engines ship with. Against a correctly configured target that produced a
> near-zero block rate that said nothing about the defence — the attack was
> simply too quiet to catch. The defaults above cross those thresholds. Turn
> them down deliberately to find where a specific system's floor is.

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
| `amountKobo` | 12,000,000 | NGN 120,000 per withdrawal. Chosen to clear the "new payee, high amount" (~NGN 50,000) and "large amount, new device" (~NGN 100,000) gates most engines ship with; the old NGN 45,000 default cleared neither |
| `delayBetweenWithdrawalsMs` | 15,000 | 15 seconds between withdrawals |
| `postLoginPauseMs` | 30,000 | Wait between password change and first withdrawal |
| `skipPasswordChange` | false | Skip the password change step (useful for testing without that signal) |

---

## Available in v0.2

### adaptive-attacker (LLM-driven)

**What it simulates:** An attacker that observes which attempts are blocked and the reason codes returned, then uses an LLM to reason about what to change. Unlike scripted scenarios, the strategy evolves mid-attack.

The LLM sees only what a real attacker would: the decision (`ALLOW`/`STEP_UP`/`BLOCK`) and the reason codes. It cannot see the target's rule weights or thresholds.

**Why this matters:** Real attackers behave this way. A defender that catches scripted attacks but fails against an adaptive adversary has a false sense of security.

**Status:** Shipped in v0.2.

---

## Available in v0.3

All seven remaining scenarios from the original plan now ship. Three of them
(`card-testing`, `promo-abuse`, `session-hijack`) need the target to implement
`scoreAction` in addition to `scoreLogin` / `scoreWithdrawal`; they throw a
clear error if the adapter does not provide it.

Three of them (`slow-drain`, `velocity-evasion`, `mule-network`, and the
timing stages of `sim-swap-takeover`) use a **simulated clock**: they advance
the `timestamp` field rather than sleeping for hours or days, and set
`simulatedTime: true` on the report. This is faithful only if the target
derives its velocity windows from the event timestamp. Against a system that
stamps server-side arrival time, these runs compress into a burst and measure
something other than what they claim — check that before trusting a result.

---

### card-testing

**What it simulates:** An attacker with a list of stolen card numbers probing
each one with a trivial authorisation to find which are still live, then
escalating to a real charge on the cards that come back approved.

**Real-world reference:** The most common automated attack against any merchant
or PSP with a card-not-present flow. Card testing is usually the *first* stage
of a fraud chain — the validated cards are then sold on or cashed out elsewhere.

**What gives it away:** Not any single transaction. Many distinct cards drawn
from a handful of BIN ranges, all card-not-present, all for near-identical
trivial amounts, in a short window, with a high decline rate.

**Card data safety:** `fraud-sim` never generates Luhn-valid numbers and never
emits a full PAN. Payloads carry an opaque token, a published sandbox BIN, and
four synthetic digits — which is what a risk API receives in practice.

**Signals that should catch this:** micro-authorisation velocity, BIN range
velocity, CNP patterns, decline-rate monitoring.

| Option | Default | Description |
|---|---|---|
| `attackerUserId` | `'card_tester_001'` | Merchant-side account doing the probing |
| `cardCount` | 60 | Distinct cards in the stolen list |
| `binCount` | 3 | BIN ranges the list is drawn from — few is the tell |
| `microAmountKobo` | 5,000 | NGN 50 probe |
| `largeAmountKobo` | 15,000,000 | NGN 150,000 once a card is known good |
| `escalateAfter` | 1 | Approvals before attempting the real charge |
| `reuseIp` | true | Card testers run from one host until it stops working |
| `delayMs` | 80 | Pause between probes |
| `maxTotalAttempts` | 300 | Hard ceiling |

**Report fields:** `cardsTested`, `cardsValidated`, `escalations`,
`escalationsAllowed`, `estimatedLossKobo`, `attackerSucceeded`, `binsUsed`.

The headline number here is not the block rate — it is whether *any* escalated
charge got through.

---

### promo-abuse

**What it simulates:** One person creating many accounts to farm a signup bonus
or referral reward, reusing devices and subnets because genuinely independent
identities cost more than the bonus is worth.

**Real-world reference:** Every fintech running an acquisition promotion. Rarely
catastrophic per incident, frequently significant in aggregate, and almost
always discovered late.

**What gives it away:** Nothing about an individual account. Device clustering,
/24 clustering, a referral graph with one referrer and no onward activity, and
many accounts cashing out to a single destination.

**Signals that should catch this:** device clustering across accounts, IP subnet
clustering, referral graph anomalies, payout concentration.

| Option | Default | Description |
|---|---|---|
| `accountCount` | 40 | Accounts to farm |
| `bonusKobo` | 200,000 | NGN 2,000 per signup |
| `deviceCount` | 3 | Distinct fingerprints spread across all accounts |
| `subnetCount` | 2 | Distinct /24s the signups come from |
| `sharedPayoutAccount` | generated | Where every account cashes out |
| `claimBonus` | true | Also attempt the claim after signup |
| `delayMs` | 120 | Pause between accounts |
| `maxTotalAttempts` | 200 | Hard ceiling |

**Report fields:** `accountsAttempted`, `accountsCreated`, `bonusesClaimed`,
`firstBlockedAtAccount`, `estimatedLossKobo`, `sharedPayoutAccount`.

The number that matters is `firstBlockedAtAccount`: a system that catches
account 40 has already paid 39 bonuses.

---

### mule-network

**What it simulates:** Layering. A source account fans funds out to intermediary
mule accounts, each of which forwards nearly all of it to a common destination,
keeping a small cut.

**Real-world reference:** How stolen funds actually leave a system. Mules are
often real people with real, previously clean accounts — which is exactly why
per-account rules struggle.

**What gives it away:** The graph, not any transaction. Fan-out followed by
fan-in, with high pass-through and low retention at every intermediate hop.

**Signals that should catch this:** graph clustering, pass-through ratio,
fan-in concentration, dormancy-then-activity.

| Option | Default | Description |
|---|---|---|
| `sourceUserId` | (required) | The compromised or complicit origin |
| `muleCount` | 8 | Intermediary accounts |
| `amountPerMuleKobo` | 30,000,000 | NGN 300,000 to each mule |
| `retentionRatio` | 0.05 | The cut each mule keeps |
| `finalDestinationAccount` | generated | Where the money ends up |
| `forwardDelayMinutes` | 45 | Simulated gap before forwarding |
| `delayMs` | 100 | Wall-clock pacing |
| `maxTotalAttempts` | 100 | Hard ceiling |

**Report fields:** `fanOutTransfers`, `forwardTransfers`, `totalMovedKobo`,
`reachedDestinationKobo`, `passThroughRatio`, `muleAccounts`,
`finalDestinationAccount`.

A system scoring transactions one at a time, with no memory of the graph, will
pass this scenario cleanly. That is the point of running it.

---

### slow-drain

**What it simulates:** The patient account takeover. Small withdrawals spaced
far enough apart that no short-window velocity rule trips, emptying the account
over days.

**Real-world reference:** What a competent attacker does once they learn that
fast drains get blocked.

**What gives it away:** Only a baseline. Any engine catches five withdrawals in
a minute; catching twenty over four days — each individually ordinary, but ten
times the account's normal outflow — requires knowing what normal is.

**Signals that should catch this:** multi-window velocity (hourly AND daily AND
weekly), baseline deviation, cumulative amount since a trust event,
payee-diversity anomalies.

| Option | Default | Description |
|---|---|---|
| `targetUserId` | (required) | The account being drained |
| `withdrawalCount` | 20 | Number of withdrawals |
| `amountKobo` | 2,500,000 | NGN 25,000 — deliberately modest |
| `amountJitterKobo` | 500,000 | Vary amounts so they don't look scripted |
| `intervalMinutes` | 300 | 5 simulated hours between withdrawals |
| `sameDevice` | true | A patient attacker keeps one stable device |
| `delayMs` | 60 | Wall-clock pacing only |
| `maxTotalAttempts` | 100 | Hard ceiling |

**Report fields:** `withdrawalsAttempted`, `drainedKobo`,
`firstBlockedAtWithdrawal`, `firstStepUpAtWithdrawal`, `simulatedTime`,
`simulatedSpan`.

Uses a simulated clock — see the note at the top of this section.

---

### session-hijack

**What it simulates:** The victim logs in legitimately; the session token is
then stolen and replayed from a different device and network to move funds.

**Real-world reference:** Malware, XSS, and hostile-network proxying. The
attacker never authenticates, so no account-takeover signal fires.

**What gives it away:** Continuity. There is no failed login, no new-device
login, no password reset — from the login endpoint's perspective nothing
happened. Only the session tells the story.

**Signals that should catch this:** session continuity (device at action vs at
login), IP continuity within a session, impossible travel within one session,
re-authentication on sensitive actions.

| Option | Default | Description |
|---|---|---|
| `targetUserId` | (required) | The victim |
| `benignActionsBeforeHijack` | 2 | The victim's own activity first |
| `amountKobo` | 20,000,000 | NGN 200,000 once the session is stolen |
| `withdrawAfterHijack` | true | Attempt the cash-out |
| `hijackFromPersona` | `'foreign'` | Where the stolen session is replayed from |
| `delayMs` | 150 | Pause between stages |

**Report fields:** `loginDecision`, `hijackedActionDecision`,
`withdrawalDecision`, `hijackDetected`, `attackerSucceeded`.

This scenario tests one claim: that the system scores the *session*, not just
the login. A system that only scores logins will let the withdrawal through and
still report a perfect block rate on its login endpoint.

Note that a `BLOCK` on the victim's own opening login is a false positive, not a
defence — the hijack has not happened yet. The scenario stops and says so.

---

### sim-swap-takeover

**What it simulates:** The victim's number is ported to the attacker's SIM,
redirecting every SMS OTP. The attacker then resets the password, logs in, and
withdraws — each step confirmed by a real OTP.

**Real-world reference:** The dominant high-value takeover vector in markets
where SMS OTP is the default second factor.

**What gives it away:** Nothing in the authentication, which all succeeds. Only
the port itself, and its recency relative to the login.

**Signals that should catch this:** telco porting checks, OTP-to-new-device
detection, login-immediately-after-port heuristics, escalation to a factor the
attacker cannot port.

| Option | Default | Description |
|---|---|---|
| `targetUserId` | (required) | The victim |
| `minutesSincePort` | 20 | How recently the number was ported |
| `amountKobo` | 40,000,000 | NGN 400,000 — SIM swaps target high-value accounts |
| `reportPortEvent` | true | Tell the target about the port, if it accepts one |
| `attemptPasswordReset` | true | Include the reset stage |
| `ipPersona` | `'domestic'` | SIM swappers are usually in-country |
| `delayMs` | 200 | Pause between stages |

**Report fields:** `stages` (ordered stage/decision pairs), `blockedAtStage`,
`resetDecision`, `loginDecision`, `withdrawalDecision`, `attackerSucceeded`.

`blockedAtStage: null` means the entire chain succeeded. This is the strongest
argument for treating SMS OTP as a signal rather than proof.

---

### velocity-evasion

**What it simulates:** One attacker who has already probed the target, learned
roughly where its rate limits sit, and now paces attempts to stay just
underneath them.

**Real-world reference:** What any attacker does after their first burst gets
blocked.

**What gives it away:** A counter with a fixed threshold is a line, and any line
can be stayed under. Only a baseline-relative threshold, a second window, or
inter-arrival analysis catches this.

**Signals that should catch this:** adaptive thresholds keyed to the user's own
baseline, multi-window counters, statistical anomaly detection on inter-arrival
times, device and network novelty (which pacing does nothing to hide).

| Option | Default | Description |
|---|---|---|
| `targetUserId` | (required) | The account being probed |
| `attemptCount` | 24 | Number of paced attempts |
| `assumedLimit` | 5 | Attempts the attacker *believes* are allowed... |
| `assumedWindowSeconds` | 600 | ...within this window |
| `safetyMargin` | 1.25 | How far under the limit they stay (1.0 = exactly at it) |
| `jitterRatio` | 0.15 | Randomise spacing — perfect regularity is its own signal |
| `rotateDevice` | true | Pacing hides volume, not novelty |
| `delayMs` | 50 | Wall-clock pacing only |
| `maxTotalAttempts` | 200 | Hard ceiling |

**Report fields:** `attemptsMade`, `firstNonAllowAtAttempt`, `evaded`,
`pacingMs`, `effectiveRatePerWindow`, `simulatedTime`, `simulatedSpan`.

Because the attacker's *belief* about the limit is a parameter, running this
with a deliberately wrong `assumedLimit` shows how much margin your thresholds
actually have. Uses a simulated clock — see the note at the top of this section.

---

## Contributing a new scenario

See [CONTRIBUTING.md](../CONTRIBUTING.md) for the contribution process. The short version: open an issue describing the attack pattern first, get approval, then submit a PR using the existing scenarios as a template.
