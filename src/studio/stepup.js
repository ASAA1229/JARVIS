// JARVIS Studio: fresh-authenticator (TOTP) step-up helpers. The code is never stored:
// it is passed straight into one request body and the caller clears the field.

export const TOTP_PATTERN = /^\d{6}$/;
export const STEP_UP_ERROR = 'Fresh authenticator verification required';

export function isValidTotpCode(value) {
  return typeof value === 'string' && TOTP_PATTERN.test(value.trim());
}

/**
 * Run a step-up action. `getStatus()` returns 'ENABLED'|'DISABLED'; `askCode(error)` resolves to a
 * 6-digit string or null (cancelled); `send(body)` performs the request and may throw an Error
 * with status 401 when the code is rejected, in which case the owner can retry.
 */
export async function withStepUp({ getStatus, askCode, send }, body = {}) {
  let status = 'DISABLED';
  try { status = await getStatus(); } catch { status = 'ENABLED'; } // fail closed: ask for a code if unsure
  if (status !== 'ENABLED') return send(body);
  let error = '';
  for (;;) {
    const code = await askCode(error);
    if (code === null || code === undefined) throw new Error('Authenticator verification cancelled');
    if (!isValidTotpCode(code)) { error = 'Enter the 6-digit code from your authenticator app.'; continue; }
    try {
      return await send({ ...body, totpCode: code.trim() });
    } catch (failure) {
      if (failure?.status !== 401) throw failure;
      error = STEP_UP_ERROR;
    }
  }
}
