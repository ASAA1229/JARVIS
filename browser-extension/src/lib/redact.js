/*
 * JARVIS browser extension: text redaction (E3:D4.21).
 * Ported from src/learning/redaction.ts (keep in step; test/browser_extension.test.ts checks parity),
 * plus browser-key and payment-card patterns. Classic script: exposes self.JarvisRedact.
 */
(function (root) {
  'use strict';
  var SECRET_PATTERNS = [
    [/-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----|$)/g, '[REDACTED PRIVATE KEY]'],
    [/\b([a-z][a-z0-9+.-]{1,20}:\/\/)[^\s:/@]+:[^\s@/]+@/gi, '$1[REDACTED]@'],
    [/\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{16,}/g, '[REDACTED API KEY]'],
    [/\bjrv_[a-f0-9]{12}_[A-Za-z0-9_-]{43}\b/g, '[REDACTED JARVIS KEY]'],
    [/\bjli_[a-f0-9]{12}_[A-Za-z0-9_-]{43}\b/g, '[REDACTED INGEST KEY]'],
    [/\bjbk_[a-f0-9]{12}_[A-Za-z0-9_-]{43}\b/g, '[REDACTED BROWSER KEY]'],
    [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g, '[REDACTED GITHUB TOKEN]'],
    [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '[REDACTED GITHUB TOKEN]'],
    [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, '[REDACTED SLACK TOKEN]'],
    [/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED AWS KEY]'],
    [/\bAIza[0-9A-Za-z_-]{35}\b/g, '[REDACTED GOOGLE KEY]'],
    [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, '[REDACTED JWT]'],
    [/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1[REDACTED]'],
    [/((?:^|[\s"'{,(])(?:[A-Za-z0-9_-]*?(?:password|passwd|pwd|secret|token|api[_-]?key|private[_-]?key|access[_-]?key|client[_-]?secret)[A-Za-z0-9_-]*)\s*[:=]\s*)(["']?)([^\s"',}]{4,})\2/gi, '$1$2[REDACTED]$2']
  ];
  var CARD = /\b\d(?:[ -]?\d){12,18}\b/g;
  var EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g;
  var PHONE = /(?<![\w.-])(?:\+\d{1,3}[\s.-]?\(?\d{2,4}\)?[\s.-]?\d{3,4}[\s.-]?\d{3,4}|\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4})(?![\w-])/g;

  function luhn(digits) {
    var sum = 0, dbl = false;
    for (var i = digits.length - 1; i >= 0; i -= 1) {
      var n = digits.charCodeAt(i) - 48;
      if (dbl) { n *= 2; if (n > 9) n -= 9; }
      sum += n; dbl = !dbl;
    }
    return sum % 10 === 0;
  }

  function redactText(text, options) {
    var opts = options || { emails: true, phones: true };
    var out = String(text == null ? '' : text);
    for (var i = 0; i < SECRET_PATTERNS.length; i += 1) out = out.replace(SECRET_PATTERNS[i][0], SECRET_PATTERNS[i][1]);
    out = out.replace(CARD, function (m) {
      var digits = m.replace(/[ -]/g, '');
      return digits.length >= 13 && digits.length <= 19 && luhn(digits) ? '[REDACTED CARD]' : m;
    });
    if (opts.emails) out = out.replace(EMAIL, '[REDACTED EMAIL]');
    if (opts.phones) out = out.replace(PHONE, '[REDACTED PHONE]');
    return out;
  }

  function redactDeep(value, options) {
    if (typeof value === 'string') return redactText(value, options);
    if (Array.isArray(value)) return value.map(function (v) { return redactDeep(v, options); });
    if (value && typeof value === 'object') {
      var out = {};
      Object.keys(value).forEach(function (k) { out[k] = redactDeep(value[k], options); });
      return out;
    }
    return value;
  }

  root.JarvisRedact = { redactText: redactText, redactDeep: redactDeep };
})(typeof self !== 'undefined' ? self : globalThis);
