/**
 * Scenario: legitimate-users
 *
 * Not an attack. Ordinary customers doing ordinary things — logging in from
 * their own phone, paying people they have paid before, occasionally buying a
 * new phone or travelling — which is the traffic a defence must let through.
 *
 * Every other scenario measures how much attack traffic gets stopped. On its
 * own that number is easy to game: a defence that blocks everything has a 100%
 * block rate. This scenario is the other half of the measurement. A block here
 * is a false positive — a real customer refused — and a step-up is friction.
 *
 * Each customer has a stable identity: one device, one browser, one home
 * address in a domestic city, and a couple of payees they already know. A short
 * warm-up gives the target some history before anything is measured, because a
 * real customer is not a stranger to the system the way a simulated one is.
 * Warm-up decisions are reported separately and excluded from the rates.
 *
 * Sessions are spread across days on a simulated clock, not sent as a burst,
 * so a velocity rule only fires on this traffic if it would fire on a real
 * customer's week. That holds only if the target reads the event timestamp —
 * see `simulatedTime` in the report.
 *
 * Behaviour, per measured session:
 *   - routine       own device, home network                 → should ALLOW
 *   - new device    a new phone, home network                → STEP_UP is fair
 *   - travel        own device, a foreign residential network → STEP_UP is fair
 *   - withdrawal    to a known payee, a normal amount        → should ALLOW
 *   - new payee     a small first payment to someone new     → STEP_UP is fair
 *
 * A customer whose login is blocked gives up for that session; one who is
 * challenged is assumed to pass the challenge and carry on, as most do.
 */

import { sleep } from '../utils/sleep.js';
import { simulatedClock, humaniseMs } from '../utils/clock.js';
import {
  buildLoginPayload,
  buildWithdrawalPayload,
  newDeviceFingerprint,
  newPayee,
  newSessionId,
} from '../utils/faker-helpers.js';
import { newResults, scoreAndCount } from '../utils/results.js';
import { randomFloat } from '../utils/random-source.js';
import { demoIpPool, pickDemoIp, pickOne, randomBrowserUserAgent, randomInt } from '../utils/random.js';

/** Stages, in the order the report lists them. */
const STAGES = [
  'routine-login',
  'new-device-login',
  'travel-login',
  'known-payee-withdrawal',
  'new-payee-withdrawal',
];

export default {
  id: 'legitimate-users',
  name: 'Legitimate customers',
  traffic: 'legitimate',
  description:
    'Ordinary customers logging in and paying people they know. Not an attack: measures false positives and friction.',

  defaultOptions: {
    targetUserIds: null, // required — one customer per id
    warmupLogins: 2, // history per customer before anything is measured
    sessionsPerUser: 4, // measured sessions per customer
    sessionGapHours: 8, // simulated time between a customer's sessions
    withdrawalRate: 0.5, // share of sessions that include a payment
    newDeviceRate: 0.1, // share of sessions on a new phone
    travelRate: 0.05, // share of sessions from abroad
    newPayeeRate: 0.1, // share of payments to someone new
    amountMinor: 2500000, // typical payment (25,000 major units)
    delayMs: 20,
  },

  async run(ctx) {
    const { options, emit, signal } = ctx;

    const userIds = options.targetUserIds;
    if (!Array.isArray(userIds) || userIds.length === 0) {
      throw new Error('legitimate-users requires options.targetUserIds (one id per customer)');
    }
    for (const key of ['withdrawalRate', 'newDeviceRate', 'travelRate', 'newPayeeRate']) {
      if (!(options[key] >= 0 && options[key] <= 1)) {
        throw new Error(`legitimate-users requires options.${key} between 0 and 1`);
      }
    }
    if (options.newDeviceRate + options.travelRate > 1) {
      throw new Error('legitimate-users requires newDeviceRate + travelRate <= 1');
    }

    const results = newResults();
    const warmup = newResults();
    const byStage = Object.fromEntries(
      STAGES.map((s) => [s, { events: 0, allowed: 0, stepUp: 0, blocked: 0 }])
    );
    const blockedCustomers = new Set();
    const falsePositiveReasons = new Map();
    let valueBlockedMinor = 0;

    const clock = simulatedClock({ start: Date.now(), stepMs: options.sessionGapHours * 3_600_000 });
    const customers = userIds.map((id, i) => newCustomer(id, i));

    emit({
      type: 'milestone',
      message:
        `${customers.length} ordinary customers, ${options.sessionsPerUser} sessions each — ` +
        'every block from here on is a false positive',
      timestamp: Date.now(),
    });

    const send = async (customer, method, payload, stage, ipIntel, tally) => {
      const response = await scoreAndCount({ ctx, method, payload, results: tally, stage, ipIntel });
      if (tally === results && response) {
        const decision = response.decision;
        const row = byStage[stage];
        row.events++;
        if (decision === 'ALLOW') row.allowed++;
        else if (decision === 'STEP_UP') row.stepUp++;
        else if (decision === 'BLOCK') {
          row.blocked++;
          blockedCustomers.add(customer.id);
          for (const reason of response.reasons ?? []) {
            const code = typeof reason === 'string' ? reason : reason?.code;
            if (code) falsePositiveReasons.set(code, (falsePositiveReasons.get(code) ?? 0) + 1);
          }
        }
      }
      try {
        await sleep(options.delayMs, signal);
      } catch {
        // aborted — the loops check `signal` before the next send
      }
      return response;
    };

    // ── Warm-up: the history a real customer would already have ─────────
    for (let i = 0; i < options.warmupLogins && !signal.aborted; i++) {
      for (const customer of customers) {
        if (signal.aborted) break;
        await send(
          customer,
          'scoreLogin',
          loginPayload(customer, customer.home.ip, clock),
          'warmup-login',
          customer.home.intel,
          warmup
        );
      }
      clock.advance();
    }

    // ── Measured sessions ───────────────────────────────────────────────
    for (let s = 0; s < options.sessionsPerUser && !signal.aborted; s++) {
      for (const customer of customers) {
        if (signal.aborted) break;

        const roll = randomFloat();
        let stage = 'routine-login';
        let network = customer.home;

        if (roll < options.travelRate) {
          stage = 'travel-login';
          network = foreignNetwork();
        } else if (roll < options.travelRate + options.newDeviceRate) {
          stage = 'new-device-login';
          // A new phone, so a new fingerprint — and from now on it is theirs.
          customer.device = newDeviceFingerprint();
        }

        const loginSent = loginPayload(customer, network.ip, clock);
        const login = await send(
          customer,
          'scoreLogin',
          loginSent,
          stage,
          network.intel,
          results
        );

        if (!login || login.decision === 'BLOCK') continue;
        if (randomFloat() >= options.withdrawalRate) continue;

        const toNewPayee = randomFloat() < options.newPayeeRate;
        // A first payment to someone new is usually small; a payment to a
        // known payee varies around the customer's usual amount.
        const amount = toNewPayee
          ? Math.round(options.amountMinor * (0.1 + randomFloat() * 0.2))
          : Math.round(options.amountMinor * (0.5 + randomFloat()));
        const payee = toNewPayee ? newPayee() : pickOne(customer.payees);

        const withdrawal = await send(
          customer,
          'scoreWithdrawal',
          buildWithdrawalPayload(
            customer.id,
            { amount, ...payee, is_new_payee: toNewPayee },
            {
              // Same session, device and network as the login, a few minutes on.
              session_id: loginSent.session_id,
              ip_address: network.ip,
              device_fingerprint: customer.device,
              timestamp: new Date(Date.parse(loginSent.timestamp) + randomInt(1, 10) * 60_000).toISOString(),
            }
          ),
          toNewPayee ? 'new-payee-withdrawal' : 'known-payee-withdrawal',
          network.intel,
          results
        );

        if (withdrawal?.decision === 'BLOCK') valueBlockedMinor += amount;
        // Once paid, a new payee is a known one next time.
        if (toNewPayee) customer.payees.push(payee);
      }
      clock.advance();
    }

    const scored = Math.max(0, results.attempts - results.errors);

    if (results.blocked > 0) {
      emit({
        type: 'milestone',
        message:
          `${results.blocked} ordinary customer event${results.blocked === 1 ? ' was' : 's were'} ` +
          `blocked — ${blockedCustomers.size} of ${customers.length} customers refused at least once`,
        timestamp: Date.now(),
      });
    }

    return {
      ...results,
      customers: customers.length,
      customersBlocked: blockedCustomers.size,
      falsePositiveRate: scored > 0 ? results.blocked / scored : 0,
      frictionRate: scored > 0 ? (results.blocked + results.stepUp) / scored : 0,
      valueBlockedMinor,
      byStage,
      falsePositiveReasons: Object.fromEntries(
        [...falsePositiveReasons].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      ),
      warmup: {
        attempts: warmup.attempts,
        blocked: warmup.blocked,
        stepUp: warmup.stepUp,
        allowed: warmup.allowed,
        errors: warmup.errors,
      },
      simulatedTime: true,
      simulatedSpan: humaniseMs(clock.elapsedMs()),
    };
  },
};

/**
 * One customer's stable identity.
 *
 * Each gets their own home address in the documentation range, carrying the
 * geolocation of a domestic city. Sharing the market's few domestic pool
 * addresses would put a dozen customers on one IP and trip any users-per-IP
 * rule — a false positive manufactured by the simulator, not found by it.
 */
function newCustomer(id, index) {
  const domestic = demoIpPool().filter((e) => e.persona === 'domestic');
  const { ip: _poolIp, ...intel } = domestic[index % domestic.length];
  return {
    id,
    device: newDeviceFingerprint(),
    userAgent: randomBrowserUserAgent(),
    // 192.0.2.100–254: RFC 5737, clear of the shared pool's .10–.12.
    home: { ip: `192.0.2.${100 + (index % 155)}`, intel },
    payees: [newPayee(), newPayee()],
  };
}

function foreignNetwork() {
  const { ip, ...intel } = pickDemoIp('foreign');
  return { ip, intel };
}

function loginPayload(customer, ip, clock) {
  // Sessions minutes apart within a round, not all on the same millisecond.
  return buildLoginPayload(customer.id, {
    session_id: newSessionId('sess'),
    ip_address: ip,
    user_agent: customer.userAgent,
    device_fingerprint: customer.device,
    timestamp: new Date(clock.epoch() + randomInt(0, 90) * 60_000).toISOString(),
  });
}
