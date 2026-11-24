export const TOTP_PATTERN: RegExp;
export const STEP_UP_ERROR: string;
export function isValidTotpCode(value: unknown): boolean;
export function withStepUp<T>(hooks: {
  getStatus(): Promise<string>;
  askCode(error: string): Promise<string | null | undefined>;
  send(body: Record<string, unknown>): Promise<T>;
}, body?: Record<string, unknown>): Promise<T>;
