/**
 * Non-negotiable automation exclusions (D2.19).
 *
 * Payment and financial applications are never automated. The planner and the adapters
 * already refuse them; this shared matcher lets the Policy Gateway enforce the same rule so
 * the exclusion holds no matter which path produced the operation, and so an approval can
 * never turn a payment target into an allowed action. There is no override.
 */
const PAYMENT_TARGET = /\b(?:phonepe|paytm|google\s*pay|gpay|paypal|wallet|banking|bank|payment|payments)\b/i;

/** Parameter names that identify the application or window an operation acts on. */
export const TARGET_PARAMETER_KEYS = ['appId', 'expectProcess', 'processName', 'titleContains'] as const;

export function isPaymentTarget(value: unknown): boolean {
  return typeof value === 'string' && PAYMENT_TARGET.test(value);
}

/** Returns the offending parameter name when any target-identifying parameter names a payment app. */
export function findPaymentTarget(parameters: Record<string, unknown>): string | undefined {
  return TARGET_PARAMETER_KEYS.find((key) => isPaymentTarget(parameters[key]));
}
