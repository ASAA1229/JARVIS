import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ExecutionResult, VerificationOutcome } from '../core/types.js';

const execFileAsync = promisify(execFile);

const EMAIL = /^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$/;
const MAX_SUBJECT = 200;
const MAX_BODY = 8000;
const MAX_RECIPIENTS = 8;

export interface EmailDraft {
  to: string[];
  cc: string[];
  subject: string;
  body: string;
}

function splitAddresses(value: unknown): string[] {
  if (value === undefined || value === null || value === '') return [];
  const raw = Array.isArray(value) ? value.map(String) : String(value).split(/[;,]/);
  return raw.map((item) => item.trim()).filter(Boolean);
}

export function parseEmailDraft(parameters: Record<string, unknown>): { ok: true; draft: EmailDraft } | { ok: false; error: string } {
  const to = splitAddresses(parameters.to);
  const cc = splitAddresses(parameters.cc);
  const subject = typeof parameters.subject === 'string' ? parameters.subject.trim() : '';
  const body = typeof parameters.body === 'string' ? parameters.body.trim() : '';
  if (to.length < 1 || to.length > MAX_RECIPIENTS) return { ok: false, error: 'Email requires 1–8 To recipients.' };
  if (cc.length > MAX_RECIPIENTS) return { ok: false, error: 'Email allows at most 8 CC recipients.' };
  if (![...to, ...cc].every((address) => EMAIL.test(address) && address.length <= 254)) {
    return { ok: false, error: 'Every recipient must be a valid email address.' };
  }
  if (!subject || subject.length > MAX_SUBJECT) return { ok: false, error: 'Subject must contain 1–200 characters.' };
  if (!body || body.length > MAX_BODY) return { ok: false, error: 'Body must contain 1–8000 characters.' };
  return { ok: true, draft: { to, cc, subject, body } };
}

export function mailtoUrl(draft: EmailDraft): string {
  const params = new URLSearchParams();
  if (draft.cc.length) params.set('cc', draft.cc.join(','));
  params.set('subject', draft.subject);
  params.set('body', draft.body);
  return `mailto:${draft.to.join(',')}?${params.toString()}`;
}

/**
 * Prepares a local mail compose handoff. This never transmits the message.
 * Delivery is unverified unless the owner sends it from the mail client.
 */
export class CommunicationsAdapter {
  public async handoffEmail(parameters: Record<string, unknown>, signal?: AbortSignal): Promise<ExecutionResult> {
    const parsed = parseEmailDraft(parameters);
    if (!parsed.ok) {
      return { success: false, outcome: VerificationOutcome.VERIFIED_FAILURE, error: parsed.error, evidence: { channel: 'email', deliveryVerified: false } };
    }
    const url = mailtoUrl(parsed.draft);
    const osHandoffEnabled = process.env.JARVIS_ENABLE_OS_HANDOFF === '1' && process.env.CI !== 'true';
    if (!osHandoffEnabled || process.platform !== 'win32') {
      return {
        success: true,
        outcome: VerificationOutcome.PARTIAL_SUCCESS,
        data: { channel: 'email', draft: parsed.draft, mailto: url, sent: false },
        evidence: {
          channel: 'email',
          deliveryVerified: false,
          osHandoffOpened: false,
          note: 'Draft is bound for owner review. JARVIS does not send email. Set JARVIS_ENABLE_OS_HANDOFF=1 on an interactive Windows session to open the local mail client.',
        },
        error: 'Email was not sent. A local compose handoff is prepared; delivery is unverified.',
      };
    }
    if (signal?.aborted) {
      return { success: false, outcome: VerificationOutcome.UNCERTAIN, error: 'Email handoff was cancelled before the mail client opened.', failureKind: 'cancelled', evidence: { channel: 'email', deliveryVerified: false } };
    }
    try {
      const rundll32 = `${process.env.SystemRoot || 'C:\\Windows'}\\System32\\rundll32.exe`;
      await execFileAsync(rundll32, ['url.dll,FileProtocolHandler', url], { timeout: 8_000, windowsHide: true, signal });
      return {
        success: true,
        outcome: VerificationOutcome.PARTIAL_SUCCESS,
        data: { channel: 'email', draft: parsed.draft, sent: false },
        evidence: { channel: 'email', deliveryVerified: false, osHandoffOpened: true, note: 'A local mail compose window was requested. Sending remains the owner\'s action.' },
        error: 'A local mail client was opened. JARVIS did not send the message and cannot verify delivery.',
      };
    } catch (error) {
      return {
        success: false,
        outcome: signal?.aborted ? VerificationOutcome.UNCERTAIN : VerificationOutcome.VERIFIED_FAILURE,
        error: error instanceof Error ? error.message : 'The local mail client could not be opened.',
        evidence: { channel: 'email', deliveryVerified: false, osHandoffOpened: false },
        interrupted: Boolean(signal?.aborted),
      };
    }
  }

  public unsupported(channel: unknown, reason?: unknown): ExecutionResult {
    const name = typeof channel === 'string' ? channel : 'unknown';
    return {
      success: false,
      outcome: VerificationOutcome.VERIFIED_FAILURE,
      failureKind: 'unsupported',
      error: typeof reason === 'string' && reason.trim()
        ? reason
        : `${name} automation is not implemented. JARVIS will not pretend this message was sent.`,
      evidence: { channel: name, deliveryVerified: false, implemented: false },
    };
  }
}
