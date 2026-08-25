/**
 * Logging adapter — logs payloads to a logger without sending anywhere.
 *
 * Used to inspect what a scenario produces before pointing at a real target.
 * Returns ALLOW for every call by default.
 *
 * @example
 *   import { loggingAdapter } from 'fraud-sim/adapters';
 *
 *   const target = loggingAdapter();
 *   await run('credential-stuffing', { target, options: { ... } });
 *   // → All payloads are printed to stdout; nothing is sent to the network
 */

export function loggingAdapter(config = {}) {
  const logger = config.logger ?? console.log;
  const defaultResponse = config.defaultResponse ?? {
    decision: 'ALLOW',
    riskScore: 0,
    reasons: [],
  };

  function log(operation, payload) {
    logger(`[fraud-sim:logging] ${operation}`, JSON.stringify(payload, null, 2));
  }

  return {
    async scoreLogin(payload) {
      log('scoreLogin', payload);
      return defaultResponse;
    },

    async scoreWithdrawal(payload) {
      log('scoreWithdrawal', payload);
      return defaultResponse;
    },

    async scoreAction(payload) {
      log('scoreAction', payload);
      return defaultResponse;
    },

    async reportEvent(eventType, data) {
      log(`reportEvent[${eventType}]`, data);
    },
  };
}
