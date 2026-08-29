/**
 * Scenario: card-testing
 *
 * An attacker holding a list of stolen card numbers needs to know which ones
 * are still live. They probe each card with a tiny authorisation — small enough
 * that a cardholder may not notice and a fraud system may not care — and then
 * escalate to a real charge on whichever cards come back approved.
 *
 * The tell is not any single transaction. It is the shape of the traffic: many
 * distinct cards, drawn from a handful of BIN ranges, all card-not-present, all
 * for near-identical trivial amounts, in a short window.
 *
 * Defensive systems should catch this via:
 *   - Micro-authorisation velocity  (many tiny auths in a short window)
 *   - BIN range velocity            (many cards sharing few BIN prefixes)
 *   - CNP transaction patterns      (no cardholder present, no address match)
 *   - Decline-rate monitoring       (a high decline ratio is itself the signal)
 *
 * Note on card data: `fraud-sim` never generates Luhn-valid numbers and never
 * emits a full PAN. Payloads carry an opaque token, a published test BIN, and
 * four synthetic digits — which is what a risk API receives in practice.
 *
 * Realistic block rates against a well-tuned system: 80-95%, and most of the
 * value is in *how early* the block comes.
 */

import { sleep } from '../utils/sleep.js';
import { buildCardAuthPayload } from '../utils/faker-helpers.js';
import { newResults, scoreAndCount } from '../utils/results.js';
import { cardBins, randomLast4, newCardToken, randomIp, pickDemoIp } from '../utils/random.js';

export default {
  id: 'card-testing',
  name: 'Card testing / BIN attack',
  description:
    'An attacker validates a list of stolen cards with micro-authorisations, then escalates to real charges on the cards that come back approved.',

  defaultOptions: {
    attackerUserId: 'card_tester_001', // the merchant-side account doing the probing
    cardCount: 60, // distinct cards in the stolen list
    binCount: 3, // how many BIN ranges the list is drawn from — few is the tell
    microAmountKobo: 5000, // NGN 50 probe
    largeAmountKobo: 15000000, // NGN 150,000 once a card is known good
    escalateAfter: 1, // approvals on a card before attempting the real charge
    delayMs: 80,
    maxTotalAttempts: 300,
    ipPersona: 'random',
    reuseIp: true, // card testers usually run from one host until it stops working
  },

  async run(ctx) {
    const { options, emit, signal } = ctx;

    if (options.cardCount < 1) {
      throw new Error('card-testing requires options.cardCount >= 1');
    }
    if (options.binCount < 1) {
      throw new Error('card-testing requires options.binCount >= 1');
    }

    const results = newResults({
      cardsTested: 0,
      cardsValidated: 0, // probes that came back ALLOW
      escalations: 0, // large charges attempted
      escalationsAllowed: 0, // large charges that got through — actual loss
    });

    const bins = cardBins().slice(0, options.binCount);
    const attacker = resolveIp(options);

    emit({
      type: 'milestone',
      message:
        `Probing ${options.cardCount} cards across ${bins.length} BIN range(s) ` +
        `with NGN ${(options.microAmountKobo / 100).toLocaleString()} authorisations`,
      timestamp: Date.now(),
    });

    for (let i = 0; i < options.cardCount; i++) {
      if (signal.aborted) break;
      if (results.attempts >= options.maxTotalAttempts) break;

      const card = {
        token: newCardToken(),
        bin: bins[i % bins.length],
        last4: randomLast4(),
      };

      // A fresh host per card would defeat the point — the attacker is trying
      // to stay cheap, and reusing infrastructure is what makes them catchable.
      const ip = options.reuseIp ? attacker : resolveIp(options);

      const probe = await scoreAndCount({
        ctx,
        method: 'scoreAction',
        payload: buildCardAuthPayload(options.attackerUserId, card, options.microAmountKobo, {
          ip_address: ip.ip,
          details: { probe: true },
        }),
        results,
        stage: 'probe',
        ipIntel: ip.intel,
      });

      results.cardsTested++;

      if (probe?.decision === 'ALLOW') {
        results.cardsValidated++;

        if (results.cardsValidated % options.escalateAfter === 0) {
          if (results.attempts >= options.maxTotalAttempts) break;

          emit({
            type: 'milestone',
            message: `Card ${card.bin}••${card.last4} approved — escalating to a real charge`,
            timestamp: Date.now(),
          });

          const charge = await scoreAndCount({
            ctx,
            method: 'scoreAction',
            payload: buildCardAuthPayload(
              options.attackerUserId,
              card,
              options.largeAmountKobo,
              { ip_address: ip.ip, details: { probe: false } }
            ),
            results,
            stage: 'escalation',
            ipIntel: ip.intel,
          });

          results.escalations++;
          if (charge?.decision === 'ALLOW') results.escalationsAllowed++;
        }
      }

      try {
        await sleep(options.delayMs, signal);
      } catch {
        break; // aborted
      }
    }

    const lossKobo = results.escalationsAllowed * options.largeAmountKobo;

    emit({
      type: 'milestone',
      message:
        `${results.cardsValidated} of ${results.cardsTested} cards validated; ` +
        `${results.escalationsAllowed} of ${results.escalations} charges succeeded ` +
        `(NGN ${(lossKobo / 100).toLocaleString()} at risk)`,
      timestamp: Date.now(),
    });

    return {
      ...results,
      // The headline number for this scenario is not the block rate — it is
      // whether any escalated charge got through at all.
      estimatedLossKobo: lossKobo,
      attackerSucceeded: results.escalationsAllowed > 0,
      binsUsed: bins,
    };
  },
};

function resolveIp(options) {
  if (!options.ipPersona || options.ipPersona === 'random') {
    return { ip: randomIp(), intel: undefined };
  }
  const persona = options.ipPersona === 'mixed' ? 'hosting' : options.ipPersona;
  const { ip, ...intel } = pickDemoIp(persona);
  return { ip, intel };
}
