/**
 * Non-negotiable automation exclusions (D2.19).
 *
 * Payment and financial applications are never automated. The planner and the adapters
 * already refuse them; this shared matcher lets the Policy Gateway enforce the same rule so
 * the exclusion holds no matter which path produced the operation, and so an approval can
 * never turn a payment target into an allowed action. There is no override.
 */
/**
 * Single source of truth for payment/financial terms. The planner, gateway, executor, desktop
 * launcher/agent adapters, window enumeration and the Android inventory all derive their
 * matching from this list so no path can drift from the exclusion.
 */
export const PAYMENT_TERMS_SOURCE = 'phonepe|paytm|google\\s*pay|gpay|paisa|paypal|wallet|banking|bank|payment|payments';
const PAYMENT_TARGET = new RegExp(`\\b(?:${PAYMENT_TERMS_SOURCE})\\b`, 'i');
/** Substring form for process names and window titles that are not word-delimited. */
export const PAYMENT_SUBSTRING_PATTERN = new RegExp(`(?:${PAYMENT_TERMS_SOURCE})`, 'i');
/** The same terms as a case-insensitive .NET/PowerShell pattern (single-quote safe). */
export const PAYMENT_POWERSHELL_PATTERN = `(?i)${PAYMENT_TERMS_SOURCE}`;

/** Parameter names that identify the application or window an operation acts on. */
export const TARGET_PARAMETER_KEYS = ['appId', 'expectProcess', 'processName', 'titleContains'] as const;

export function isPaymentTarget(value: unknown): boolean {
  return typeof value === 'string' && PAYMENT_TARGET.test(value);
}

/** Returns the offending parameter name when any target-identifying parameter names a payment app. */
export function findPaymentTarget(parameters: Record<string, unknown>): string | undefined {
  return TARGET_PARAMETER_KEYS.find((key) => isPaymentTarget(parameters[key]));
}
