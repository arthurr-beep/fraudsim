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
      amount: randomInt(100000, 5000000),
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
