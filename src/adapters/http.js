/**
 * HTTP target adapter — sends events to a REST API.
 *
 * Configurable for any target's response shape via the `responseMap` function.
 * This is the key flexibility point that keeps fraud-sim target-agnostic:
 * a user testing against Stripe Radar writes a different responseMap than
 * one testing against an in-house system.
 *
 * @example
 *   const target = httpAdapter({
 *     baseUrl: 'https://api.frisklayer.com',
 *     headers: { Authorization: `Bearer ${process.env.FRISKLAYER_KEY}` },
 *     endpoints: {
 *       scoreLogin:      '/v1/score/login',
 *       scoreWithdrawal: '/v1/score/withdrawal',
 *     },
 *     responseMap: (raw) => ({
 *       decision:  raw.decision,
 *       riskScore: raw.risk_score,
 *       reasons:   raw.reasons,
 *       raw,
 *     }),
 *     // Only if your API signals a genuine block with an HTTP status:
 *     blockOnStatus: [403],
 *   });
 *
 * ── On HTTP failures ──────────────────────────────────────────────────
 * A non-2xx response is treated as an infrastructure error, NOT as a block,
 * unless its status is listed in `blockOnStatus`. This matters: if a 429 or a
 * 503 counted as a BLOCK, then rate-limiting the simulator or crashing the
 * target under load would *raise* its measured block rate. A benchmark that
 * rewards a target for falling over is measuring the opposite of what it
 * claims, so errors are reported as errors and excluded from the block rate.
 */

const DEFAULT_ENDPOINTS = {
  scoreLogin: '/v1/score/login',
  scoreWithdrawal: '/v1/score/withdrawal',
  scoreAction: '/v1/score/action',
  reportEvent: (type) => `/v1/event/${type}`,
};

// Default responseMap — works for snake_case APIs that match FriskLayer's shape.
// Users with different APIs override this.
const DEFAULT_RESPONSE_MAP = (raw) => ({
  decision: raw.decision,
  riskScore: raw.risk_score ?? raw.riskScore,
  reasons: raw.reasons ?? [],
  raw,
});

export function httpAdapter(config) {
  if (!config || !config.baseUrl) {
    throw new Error('httpAdapter requires { baseUrl }');
  }

  const baseUrl = config.baseUrl.replace(/\/$/, '');
  const headers = {
    'Content-Type': 'application/json',
    ...(config.headers ?? {}),
  };
  const endpoints = { ...DEFAULT_ENDPOINTS, ...(config.endpoints ?? {}) };
  const responseMap = config.responseMap ?? DEFAULT_RESPONSE_MAP;
  const timeoutMs = config.timeoutMs ?? 5000;
  // Statuses this specific API uses to signal a real block. Empty by default:
  // no standard HTTP status means "the fraud engine decided to block", and
  // guessing is how an outage gets scored as a successful defence.
  const blockOnStatus = new Set(config.blockOnStatus ?? []);
  const fetchImpl = config.fetch ?? globalThis.fetch;

  if (!fetchImpl) {
    throw new Error(
      'No fetch implementation found. Use Node 20+, or pass { fetch } to httpAdapter.'
    );
  }

  async function call(path, body) {
    const url = `${baseUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      const raw = await res.json().catch(() => ({}));

      if (!res.ok) {
        // Only statuses the caller has explicitly declared as blocks count as
        // blocks. Everything else is infrastructure trouble and is reported as
        // such — see the note at the top of this file.
        if (blockOnStatus.has(res.status)) {
          return {
            decision: raw.decision ?? 'BLOCK',
            riskScore: raw.risk_score ?? 1.0,
            reasons: raw.reasons ?? [{ code: 'HTTP_BLOCK', label: `HTTP ${res.status}` }],
            raw,
            httpStatus: res.status,
          };
        }

        return {
          decision: 'ERROR',
          riskScore: null,
          reasons: [{ code: errorCodeFor(res.status), label: `HTTP ${res.status}` }],
          raw,
          httpStatus: res.status,
          // Scenarios and the runner key off this to keep infrastructure
          // failures out of the block rate.
          infraError: true,
          retryAfter: res.headers?.get?.('retry-after') ?? null,
        };
      }

      return responseMap(raw);
    } catch (err) {
      // Network-level failures — timeout, DNS, connection refused.
      // We return a synthetic ERROR decision so scenarios can decide
      // whether to continue or abort.
      return {
        decision: 'ERROR',
        riskScore: null,
        reasons: [{ code: 'NETWORK_ERROR', label: err.message }],
        raw: { error: err.message },
        infraError: true,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async scoreLogin(payload) {
      return call(endpoints.scoreLogin, payload);
    },

    async scoreWithdrawal(payload) {
      return call(endpoints.scoreWithdrawal, payload);
    },

    async scoreAction(payload) {
      return call(endpoints.scoreAction, payload);
    },

    async reportEvent(eventType, data) {
      const path =
        typeof endpoints.reportEvent === 'function'
          ? endpoints.reportEvent(eventType)
          : endpoints.reportEvent;
      // Fire-and-forget — never block a scenario on a report
      try {
        await call(path, data);
      } catch {
        // Intentionally swallow — reports are not critical
      }
    },
  };
}

/**
 * Name the failure so a report says why a run is unreliable, not just that it
 * is. Rate limiting and server errors have very different remedies.
 */
function errorCodeFor(status) {
  if (status === 429) return 'RATE_LIMITED';
  if (status >= 500) return 'SERVER_ERROR';
  if (status === 401 || status === 403) return 'AUTH_ERROR';
  if (status === 404) return 'ENDPOINT_NOT_FOUND';
  return 'HTTP_ERROR';
}
