/*
 * JARVIS browser extension: privacy policy helpers (E3:D4.21). Classic script: exposes self.JarvisPolicy.
 *  - blocklist: hosts where the extension refuses to read (banking, mail, health by default; user-editable)
 *  - loopback-only server URL validation
 */
(function (root) {
  'use strict';
  /* Entry syntax: "example.com" (host and subdomains), "example.com/path" (path prefix),
   * "*word*" (substring of the host), "label.*" (first host label). */
  var DEFAULT_BLOCKLIST = [
    // banking and payments
    '*bank*', 'paypal.com', 'chase.com', 'wellsfargo.com', 'citi.com', 'capitalone.com', 'americanexpress.com',
    'discover.com', 'usbank.com', 'schwab.com', 'fidelity.com', 'vanguard.com', 'hsbc.com', 'barclays.co.uk',
    'lloydsbank.com', 'natwest.com', 'santander.com', 'td.com', 'rbc.com', 'scotiabank.com', 'bmo.com',
    'hdfcbank.com', 'icicibank.com', 'sbi.co.in', 'axisbank.com', 'wise.com', 'venmo.com', 'stripe.com',
    // mail inboxes
    'mail.google.com', 'outlook.live.com', 'outlook.office.com', 'outlook.office365.com', 'mail.yahoo.com',
    'mail.proton.me', 'proton.me', 'protonmail.com', 'mail.aol.com', 'fastmail.com', 'zoho.com/mail', 'icloud.com/mail',
    'webmail.*', '*webmail*',
    // health and patient portals
    '*mychart*', 'kp.org', 'anthem.com', 'cigna.com', 'uhc.com', 'unitedhealthcare.com', 'aetna.com', 'bupa.co.uk',
    'nhs.uk', 'medicare.gov', 'healthcare.gov', 'teladoc.com', '23andme.com', '*patientportal*', '*healthrecords*'
  ];

  function parseUrl(url) {
    try { return new URL(url); } catch (e) { return null; }
  }

  /** True when the page must not be read: unsupported scheme, a browser-internal page, or a blocklist match. */
  function isBlocked(url, blocklist) {
    var u = parseUrl(url);
    if (!u || (u.protocol !== 'http:' && u.protocol !== 'https:')) return true;
    var host = u.hostname.toLowerCase().replace(/\.$/, '');
    var path = u.pathname.toLowerCase();
    var list = Array.isArray(blocklist) ? blocklist : DEFAULT_BLOCKLIST;
    for (var i = 0; i < list.length; i += 1) {
      var entry = String(list[i] || '').trim().toLowerCase();
      if (!entry) continue;
      if (entry.length > 2 && entry.charAt(0) === '*' && entry.charAt(entry.length - 1) === '*') {
        if (host.indexOf(entry.slice(1, -1)) !== -1) return true;
        continue;
      }
      if (entry.slice(-2) === '.*') {
        if (host.split('.')[0] === entry.slice(0, -2)) return true;
        continue;
      }
      var slash = entry.indexOf('/');
      var h = slash === -1 ? entry : entry.slice(0, slash);
      var p = slash === -1 ? '' : entry.slice(slash);
      if (host === h || host.slice(-(h.length + 1)) === '.' + h) {
        if (!p || path === p || path.indexOf(p + '/') === 0) return true;
      }
    }
    return false;
  }

  /** Parse a user-edited blocklist (one entry per line or comma separated). */
  function parseBlocklist(text) {
    return String(text || '').split(/[\n,]+/).map(function (s) { return s.trim().toLowerCase(); })
      .filter(function (s) { return s && s.length <= 100 && /^[a-z0-9*._\/-]+$/.test(s); }).slice(0, 500);
  }

  /** Only loopback http URLs are accepted as the JARVIS server. Returns the origin or null. */
  function normalizeServerUrl(value) {
    var u = parseUrl(String(value || '').trim());
    if (!u || u.protocol !== 'http:') return null;
    var host = u.hostname;
    if (host !== '127.0.0.1' && host !== 'localhost' && host !== '[::1]') return null;
    if (u.username || u.password) return null;
    return u.origin;
  }

  root.JarvisPolicy = { DEFAULT_BLOCKLIST: DEFAULT_BLOCKLIST, isBlocked: isBlocked, parseBlocklist: parseBlocklist, normalizeServerUrl: normalizeServerUrl };
})(typeof self !== 'undefined' ? self : globalThis);
