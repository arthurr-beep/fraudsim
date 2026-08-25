/**
 * Mock adapter — returns predetermined responses in sequence.
 *
 * Primary use case: unit testing scenarios. Lets a test verify that a
 * scenario behaves correctly given a known sequence of target responses.
 *
 * @example
 *   const target = mockAdapter({
 *     scoreLogin: [
 *       { decision: 'ALLOW' },
 *       { decision: 'STEP_UP', riskScore: 0.5 },
 *       { decision: 'BLOCK',   riskScore: 0.9, reasons: [{ code: 'NEW_DEVICE' }] },
 *     ],
 *   });
 *
 * After the queue is exhausted, the adapter returns the last response repeatedly,
 * unless `defaultResponse` is provided.
 */

export function mockAdapter(config = {}) {
  const state = {
    scoreLogin: queueFrom(config.scoreLogin),
    scoreWithdrawal: queueFrom(config.scoreWithdrawal),
    scoreAction: queueFrom(config.scoreAction),
    reportedEvents: [],
  };

  const defaultResponse = config.defaultResponse ?? {
    decision: 'ALLOW',
    riskScore: 0,
    reasons: [],
  };

  function dequeue(name) {
    const queue = state[name];
    if (queue.length === 0) return defaultResponse;
    return queue.length === 1 ? queue[0] : queue.shift();
  }

  return {
    async scoreLogin(payload) {
      state.scoreLogin._calls.push(payload);
      return dequeue('scoreLogin');
    },

    async scoreWithdrawal(payload) {
      state.scoreWithdrawal._calls.push(payload);
      return dequeue('scoreWithdrawal');
    },

    async scoreAction(payload) {
      state.scoreAction._calls.push(payload);
      return dequeue('scoreAction');
    },

    async reportEvent(eventType, data) {
      state.reportedEvents.push({ type: eventType, data });
    },

    /**
     * Test helper: return all payloads received by a given endpoint.
     */
    _calls(name) {
      return state[name]?._calls ?? [];
    },

    /**
     * Test helper: return all reported events.
     */
    _reportedEvents() {
      return state.reportedEvents;
    },
  };
}

function queueFrom(responses) {
  const arr = Array.isArray(responses) ? [...responses] : [];
  arr._calls = [];
  return arr;
}
