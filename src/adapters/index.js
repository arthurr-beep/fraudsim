/**
 * Target adapters — the bridge between scenarios and the system under test.
 *
 * A TargetAdapter has this shape:
 *   {
 *     scoreLogin(payload)      => Promise<TargetResponse>
 *     scoreWithdrawal(payload) => Promise<TargetResponse>
 *     scoreAction(payload)     => Promise<TargetResponse>   // v0.3+
 *     reportEvent(type, data)  => Promise<void>
 *   }
 *
 * TargetResponse shape:
 *   {
 *     decision: 'ALLOW' | 'STEP_UP' | 'BLOCK' | string,
 *     riskScore?: number,
 *     reasons?: Array<{ code: string, label?: string, weight?: number }>,
 *     raw?: object,
 *   }
 */

export { httpAdapter } from './http.js';
export { mockAdapter } from './mock.js';
export { loggingAdapter } from './logging.js';
