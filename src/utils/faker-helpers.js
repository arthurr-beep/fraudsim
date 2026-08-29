/**
 * Shared payload builders. Centralised here so all scenarios produce
 * structurally consistent payloads — and so adding a field to all
 * scenarios at once is a one-line change.
 *
 * Uses the internal `random.js` utilities to avoid a faker dependency.
 */

import {
  alphanumeric,
  randomIp,
  randomUserAgent,
  randomAccountNumber,
  randomBank,
  randomFullName,
  randomInt,
  randomCardBin,
  randomLast4,
  newCardToken,
  randomPhoneNumber,
  pickOne,
} from './random.js';

export function newSessionId(prefix = 'sim') {
  return `${prefix}_${alphanumeric(10)}`;
}

export function newDeviceFingerprint() {
  return alphanumeric(32);
}

export function newReference() {
  return `TXN_${Date.now()}_${alphanumeric(6)}`;
}

export function newPayee() {
  return {
    payee_account: randomAccountNumber(),
    payee_bank: randomBank(),
    payee_name: randomFullName(),
  };
}

export function buildLoginPayload(userId, overrides = {}) {
  return {
    user_id: userId,
    session_id: newSessionId(),
    ip_address: randomIp(),
    user_agent: randomUserAgent(),
    device_fingerprint: newDeviceFingerprint(),
    timestamp: new Date().toISOString(),
    metadata: {
      login_method: 'password',
      platform: pickOne(['web', 'android', 'ios']),
      _simulated: true,
    },
    ...overrides,
  };
}

export function buildWithdrawalPayload(userId, transaction = {}, overrides = {}) {
  const payee = newPayee();
  return {
    user_id: userId,
    session_id: newSessionId(),
    ip_address: randomIp(),
    device_fingerprint: newDeviceFingerprint(),
    timestamp: new Date().toISOString(),
    transaction: {
      // NGN 50,000 - 250,000 in kobo. The previous ceiling (NGN 50,000) sat
      // exactly on the "new payee, high amount" threshold most engines ship
      // with, and those rules compare with `>`, so the rule never fired.
      amount: randomInt(5000000, 25000000),
      currency: 'NGN',
      ...payee,
      is_new_payee: true,
      reference: newReference(),
      ...transaction,
    },
    metadata: { _simulated: true },
    ...overrides,
  };
}

/**
 * Generic non-login, non-withdrawal event, sent to the target's `scoreAction`
 * endpoint. Signups, promo claims, card authorisations and profile changes all
 * ride on this shape so a target only has to map one extra endpoint.
 */
export function buildActionPayload(userId, actionType, details = {}, overrides = {}) {
  // `details` is merged, not replaced. Spreading `overrides` wholesale would
  // let a caller adding one detail field silently drop every other one —
  // which is how a card payload can lose its BIN and still look well-formed.
  const { details: detailOverrides, ...topLevel } = overrides;

  return {
    user_id: userId,
    session_id: newSessionId(),
    action_type: actionType,
    ip_address: randomIp(),
    user_agent: randomUserAgent(),
    device_fingerprint: newDeviceFingerprint(),
    timestamp: new Date().toISOString(),
    metadata: { _simulated: true },
    ...topLevel,
    details: { ...details, ...(detailOverrides ?? {}) },
  };
}

/** A new-account signup, as promo abuse would generate it. */
export function buildSignupPayload(userId, overrides = {}) {
  return buildActionPayload(
    userId,
    'signup',
    {
      email: `${userId}@example.invalid`,
      phone: randomPhoneNumber(),
      full_name: randomFullName(),
    },
    overrides
  );
}

/**
 * A card authorisation attempt.
 *
 * Carries a token, BIN and last four — never a full card number. See
 * `randomCardBin` for why.
 */
export function buildCardAuthPayload(userId, card = {}, amountKobo = 5000, overrides = {}) {
  return buildActionPayload(
    userId,
    'card_auth',
    {
      card_token: card.token ?? newCardToken(),
      card_bin: card.bin ?? randomCardBin(),
      card_last4: card.last4 ?? randomLast4(),
      amount: amountKobo,
      currency: 'NGN',
      entry_mode: 'card_not_present',
    },
    overrides
  );
}

/**
 * An account-to-account transfer. Structurally a withdrawal, but names the
 * destination account explicitly so mule-network runs can be traced.
 */
export function buildTransferPayload(userId, destinationAccount, amountKobo, overrides = {}) {
  return buildWithdrawalPayload(
    userId,
    {
      amount: amountKobo,
      payee_account: destinationAccount,
      is_new_payee: overrides.isNewPayee ?? true,
    },
    overrides
  );
}
