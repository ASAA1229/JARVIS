/**
 * Server-side redaction for browsing content (E3:D4.21): the learning redaction rules plus browser key
 * and payment-card patterns. The extension applies the same rules before text leaves the browser
 * (browser-extension/src/lib/redact.js); the server re-applies them as defence in depth.
 */
import { redactText as learningRedactText } from '../learning/redaction.js';

const BROWSER_KEY = /\bjbk_[a-f0-9]{12}_[A-Za-z0-9_-]{43}\b/g;
const CARD = /\b\d(?:[ -]?\d){12,18}\b/g;

function luhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let n = digits.charCodeAt(i) - 48;
    if (double) { n *= 2; if (n > 9) n -= 9; }
    sum += n;
    double = !double;
  }
  return sum % 10 === 0;
}

export function redactBrowserText(text: string): string {
  let out = String(text ?? '');
  out = out.replace(BROWSER_KEY, '[REDACTED BROWSER KEY]');
  out = out.replace(CARD, (match) => {
    const digits = match.replace(/[ -]/g, '');
    return digits.length >= 13 && digits.length <= 19 && luhn(digits) ? '[REDACTED CARD]' : match;
  });
  return learningRedactText(out);
}

export function redactBrowserDeep<T>(value: T): T {
  if (typeof value === 'string') return redactBrowserText(value) as unknown as T;
  if (Array.isArray(value)) return value.map((item) => redactBrowserDeep(item)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) out[key] = redactBrowserDeep(item);
    return out as T;
  }
  return value;
}

