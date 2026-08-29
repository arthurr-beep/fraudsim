/**
 * Scenario: promo-abuse
 *
 * One person creating many accounts to farm a signup bonus or referral reward.
 * Each account is individually unremarkable — a plausible name, a plausible
 * phone number, a real signup flow. The fraud is only visible in aggregate.
 *
 * The attacker's constraint is effort: creating a genuinely independent
 * identity per account (new device, new network, new payout destination) costs
 * more than the bonus is worth. So they reuse something. This scenario models
 * that reuse explicitly and lets you dial it up or down.
 *
 * Defensive systems should catch this via:
 *   - Device clustering        (one fingerprint behind many accounts)
 *   - IP /24 clustering        (accounts from one subnet)
 *   - Referral graph anomalies (one referrer, many referees, no onward activity)
 *   - Payout concentration     (many accounts cashing out to one destination)
 *
 * The interesting question this scenario answers is not "is it blocked" but
 * "how many accounts got through before it was". A system that catches account
 * 40 has already paid 39 bonuses.
 */

import { sleep } from '../utils/sleep.js';
import {
  buildSignupPayload,
  buildActionPayload,
  newDeviceFingerprint,
} from '../utils/faker-helpers.js';
import { newResults, scoreAndCount } from '../utils/results.js';
import { randomIp, ipInSameSubnet, randomAccountNumber, alphanumeric } from '../utils/random.js';

export default {
  id: 'promo-abuse',
  name: 'Promo and referral abuse',
  description:
    'One actor creates many accounts to farm signup bonuses, reusing devices, subnets, and a shared payout destination.',

  defaultOptions: {
    accountCount: 40,
    bonusKobo: 200000, // NGN 2,000 per signup
    deviceCount: 3, // distinct fingerprints spread across all accounts
    subnetCount: 2, // distinct /24s the signups come from
    sharedPayoutAccount: null, // null → generated; all cash-outs land here
    claimBonus: true, // also attempt the bonus claim after signup
    delayMs: 120,
    maxTotalAttempts: 200,
  },

  async run(ctx) {
    const { options, emit, signal } = ctx;

    if (options.accountCount < 1) {
      throw new Error('promo-abuse requires options.accountCount >= 1');
    }
    if (options.deviceCount < 1 || options.subnetCount < 1) {
      throw new Error('promo-abuse requires deviceCount and subnetCount >= 1');
    }

    const results = newResults({
      accountsAttempted: 0,
      accountsCreated: 0, // signups that were not blocked
      bonusesClaimed: 0, // claims that came back ALLOW — actual payout
      firstBlockedAtAccount: null,
    });

    // The reused resources. Fewer of these = a lazier, more catchable attacker.
    const devices = Array.from({ length: options.deviceCount }, () => newDeviceFingerprint());
    const subnetSeeds = Array.from({ length: options.subnetCount }, () => randomIp());
    const payoutAccount = options.sharedPayoutAccount ?? randomAccountNumber();
    const referrer = `promo_farmer_${alphanumeric(6)}`;

    emit({
      type: 'milestone',
      message:
        `Farming ${options.accountCount} accounts for NGN ` +
        `${(options.bonusKobo / 100).toLocaleString()} each across ${devices.length} device(s) ` +
        `and ${subnetSeeds.length} subnet(s), all paying out to ${payoutAccount}`,
      timestamp: Date.now(),
    });

    for (let i = 0; i < options.accountCount; i++) {
      if (signal.aborted) break;
      if (results.attempts >= options.maxTotalAttempts) break;

      const userId = `promo_acct_${String(i + 1).padStart(3, '0')}`;
      const device = devices[i % devices.length];
      const ip = ipInSameSubnet(subnetSeeds[i % subnetSeeds.length]);

      results.accountsAttempted++;

      const signup = await scoreAndCount({
        ctx,
        method: 'scoreAction',
        payload: buildSignupPayload(userId, {
          ip_address: ip,
          device_fingerprint: device,
          details: {
            referred_by: referrer,
            signup_bonus_kobo: options.bonusKobo,
            payout_account: payoutAccount,
          },
        }),
        results,
        stage: 'signup',
      });

      if (signup?.decision === 'BLOCK') {
        if (results.firstBlockedAtAccount == null) {
          results.firstBlockedAtAccount = i + 1;
          emit({
            type: 'milestone',
            message: `First signup blocked at account ${i + 1} — ${results.bonusesClaimed} bonuses already paid`,
            timestamp: Date.now(),
          });
        }
      } else {
        results.accountsCreated++;

        if (options.claimBonus && results.attempts < options.maxTotalAttempts) {
          const claim = await scoreAndCount({
            ctx,
            method: 'scoreAction',
            payload: buildActionPayload(
              userId,
              'promo_claim',
              {
                bonus_kobo: options.bonusKobo,
                payout_account: payoutAccount,
                referred_by: referrer,
              },
              { ip_address: ip, device_fingerprint: device }
            ),
            results,
            stage: 'claim',
          });

          if (claim?.decision === 'ALLOW') results.bonusesClaimed++;
        }
      }

      try {
        await sleep(options.delayMs, signal);
      } catch {
        break;
      }
    }

    const paidKobo = results.bonusesClaimed * options.bonusKobo;

    emit({
      type: 'milestone',
      message:
        `${results.accountsCreated} of ${results.accountsAttempted} accounts created, ` +
        `${results.bonusesClaimed} bonuses paid (NGN ${(paidKobo / 100).toLocaleString()})`,
      timestamp: Date.now(),
    });

    return {
      ...results,
      estimatedLossKobo: paidKobo,
      attackerSucceeded: results.bonusesClaimed > 0,
      sharedPayoutAccount: payoutAccount,
      devicesUsed: devices.length,
      subnetsUsed: subnetSeeds.length,
    };
  },
};
