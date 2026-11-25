// TEMPORARY / TEST DATA: fictional pages, fake credentials and fake card numbers only (E3:D4.21).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import vm from 'node:vm';
import { parseHtml } from './helpers/miniDom.js';
import { redactText as serverRedact } from '../src/learning/redaction.js';
// @ts-expect-error plain ESM JS modules without type declarations
import { buildManifest, TARGETS } from '../browser-extension/manifest.mjs';
// @ts-expect-error plain ESM JS modules without type declarations
import { build } from '../browser-extension/build.mjs';

const root = resolve('browser-extension');
function load(files: string[], extra: Record<string, unknown> = {}) {
  const context: Record<string, unknown> = { URL, TextDecoder, console, ...extra };
  context['self'] = context;
  vm.createContext(context);
  for (const file of files) vm.runInContext(readFileSync(join(root, 'src', file), 'utf8'), context, { filename: file });
  return context as Record<string, any>;
}
/** vm values come from another realm; round-trip through JSON for strict deep comparisons. */
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value));

const lib = load(['lib/redact.js', 'lib/policy.js', 'lib/extract.js']);
const Extract = lib['JarvisExtract'];
const Policy = lib['JarvisPolicy'];
const Redact = lib['JarvisRedact'];

const FIXTURE = `<!doctype html>
<html><head>
<title>Fallback title | Example Journal</title>
<link rel="canonical" href="https://journal.example.org/articles/widgets?utm_source=feed#top">
<meta name="description" content="A fictional article about widgets.">
<meta property="og:title" content="How widgets work">
<meta property="og:type" content="article">
<meta property="og:site_name" content="Example Journal">
<meta property="article:published_time" content="2026-02-01T08:00:00Z">
<meta property="article:modified_time" content="2026-02-03T09:30:00Z">
<meta name="author" content="Ada Example">
<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"Article","headline":"How widgets work","author":{"@type":"Person","name":"Ada Example"}},{"@type":"Product","name":"Widget One","offers":{"price":"19.99"}}]}</script>
<script type="application/ld+json">{ this is not json </script>
<script>window.secretScriptText = "SCRIPT-BODY-SHOULD-NOT-APPEAR";</script>
<style>.x{color:red}</style>
</head><body>
<nav><a href="/home">Home</a> <a href="/about">About</a> NAV-TEXT</nav>
<main>
<article itemscope itemtype="https://schema.org/Article">
<h1 itemprop="headline">How widgets work</h1>
<p>By <a rel="author" href="/people/ada">Ada Example</a> on <time datetime="2026-02-01">1 Feb 2026</time></p>
<p>Widgets are small devices that convert input into output. They come in three modes, and each mode is explained below in some detail. This paragraph is intentionally long enough to count as article content for the readability heuristic.</p>
<h2>Modes</h2>
<ul><li>Fast mode</li><li>Slow mode</li><li>Eco mode</li></ul>
<p>Read the <a href="/docs/specs?session=abc123#intro">specification</a> or visit <a href="https://other.example.net/page">another site</a> or <a href="javascript:alert(1)">bad link</a>.</p>
<table><caption>Mode speeds</caption><thead><tr><th>Mode</th><th>Speed</th></tr></thead><tbody><tr><td>Fast</td><td>10</td></tr><tr><td>Slow</td><td>2</td></tr></tbody></table>
<dl><dt>Voltage</dt><dd>5 V</dd><dt>Weight</dt><dd>40 g</dd></dl>
<div hidden>HIDDEN-ATTR-TEXT</div>
<div style="display: none">HIDDEN-STYLE-TEXT</div>
<div contenteditable="true">TYPED-DRAFT-TEXT</div>
<div itemprop="author" itemscope itemtype="https://schema.org/Person"><span itemprop="name">Ada Example</span></div>
<meta itemprop="datePublished" content="2026-02-01">
</article>
</main>
<aside>ASIDE-TEXT related links</aside>
<form id="login" action="/session?next=%2Fprivate" method="post">
<h2>Sign in</h2>
<label for="u">Username</label><input id="u" name="username" type="text" value="alice-typed-name">
<label for="p">Password</label><input id="p" name="password" type="password" value="hunter2-secret" required autocomplete="current-password">
<input type="hidden" name="csrf" value="CSRF-TOKEN-VALUE">
<button type="submit">Log in</button>
</form>
<form id="pay" action="/checkout">
<label>Card number <input name="cardnumber" autocomplete="cc-number" value="4111111111111111"></label>
<label>Country <select name="country"><option>Norway</option><option>Peru</option></select></label>
<textarea name="note">TEXTAREA-CONTENT</textarea>
<input type="submit" value="Pay">
</form>
<form role="search" action="/search"><input type="search" name="q" placeholder="Search the journal" value="typed query"><button>Go</button></form>
<footer>FOOTER-TEXT &copy; Example Journal</footer>
</body></html>`;

const doc = () => parseHtml(FIXTURE);
const URL_ = 'https://journal.example.org/articles/widgets?utm=1#x';
const everything = () => plain(Extract.extractPage(doc(), { url: URL_, include: { structured: true, forms: true } }));

test('reader returns the article text and leaves out scripts, nav, aside, footer, hidden and editable content', () => {
  const page = everything();
  assert.match(page.text, /Widgets are small devices/);
  assert.match(page.text, /Fast mode/);
  for (const banned of ['SCRIPT-BODY', 'NAV-TEXT', 'ASIDE-TEXT', 'FOOTER-TEXT', 'HIDDEN-ATTR', 'HIDDEN-STYLE', 'TYPED-DRAFT', 'TEXTAREA-CONTENT', 'color:red']) {
    assert.equal(page.text.includes(banned), false, `${banned} must not be in the text`);
  }
  assert.equal(page.url, 'https://journal.example.org/articles/widgets', 'query string and fragment are dropped');
  assert.equal(page.truncated, false);
});

test('reader never reads password, card or any input values', () => {
  const wire = JSON.stringify(everything());
  for (const banned of ['hunter2-secret', '4111111111111111', 'alice-typed-name', 'CSRF-TOKEN-VALUE', 'typed query', 'TEXTAREA-CONTENT']) {
    assert.equal(wire.includes(banned), false, `${banned} leaked`);
  }
  const reader = readFileSync(join(root, 'src/lib/extract.js'), 'utf8');
  assert.equal(/\.value\b|getAttribute\(['"]value['"]\)|attr\([a-z]+, ?['"]value['"]\)/.test(reader), false, 'the reader has no code path that reads values');
});

test('headings, links and metadata', () => {
  const page = everything();
  assert.deepEqual(page.headings.map((h: { level: number; text: string }) => [h.level, h.text]), [[1, 'How widgets work'], [2, 'Modes']]);
  const hrefs = page.links.map((l: { href: string }) => l.href);
  assert.ok(hrefs.includes('https://journal.example.org/docs/specs'), 'relative link resolved, query dropped');
  assert.ok(hrefs.includes('https://other.example.net/page'));
  assert.equal(hrefs.some((h: string) => h.startsWith('javascript')), false);
  assert.equal(hrefs.includes('https://journal.example.org/home'), false, 'nav links are boilerplate');
  assert.equal(page.meta.title, 'How widgets work');
  assert.equal(page.meta.canonical, 'https://journal.example.org/articles/widgets');
  assert.equal(page.meta.description, 'A fictional article about widgets.');
  assert.equal(page.meta.published, '2026-02-01T08:00:00Z');
  assert.equal(page.meta.modified, '2026-02-03T09:30:00Z');
  assert.equal(page.meta.author, 'Ada Example');
  assert.equal(page.meta.siteName, 'Example Journal');
  assert.equal(page.meta.openGraph.type, 'article');
});

test('structured data: JSON-LD, microdata, tables, lists and key-value pairs', () => {
  const page = everything();
  assert.equal(page.jsonld.length, 2, 'invalid JSON-LD is skipped, @graph is flattened');
  assert.deepEqual(page.jsonld.map((x: { '@type': string }) => x['@type']), ['Article', 'Product']);
  assert.equal(page.tables.length, 1);
  assert.deepEqual(page.tables[0], { caption: 'Mode speeds', headers: ['Mode', 'Speed'], rows: [['Fast', '10'], ['Slow', '2']], truncated: false });
  assert.deepEqual(page.lists[0].items, ['Fast mode', 'Slow mode', 'Eco mode']);
  assert.deepEqual(page.keyValue, [{ key: 'Voltage', value: '5 V' }, { key: 'Weight', value: '40 g' }]);
  const article = page.microdata[0];
  assert.equal(article.type, 'https://schema.org/Article');
  assert.equal(article.properties.headline, 'How widgets work');
  assert.equal(article.properties.author.properties.name, 'Ada Example');
});

test('forms are described by field, label and type only, and never carry values', () => {
  const page = everything();
  assert.equal(page.forms.length, 3);
  const login = page.forms[0];
  assert.equal(login.action, '/session', 'form action loses its query string');
  assert.equal(login.purposeGuess, 'login');
  const password = login.fields.find((f: { type: string }) => f.type === 'password');
  assert.equal(password.sensitive, true);
  assert.equal(password.required, true);
  assert.equal(password.label, 'Password');
  assert.equal(login.fields.some((f: { name?: string }) => f.name === 'csrf'), false, 'hidden inputs are not described');
  const pay = page.forms[1];
  assert.equal(pay.purposeGuess, 'payment');
  assert.equal(pay.fields.find((f: { name?: string }) => f.name === 'cardnumber').sensitive, true);
  assert.deepEqual(pay.fields.find((f: { tag: string }) => f.tag === 'select').options, ['Norway', 'Peru']);
  assert.equal(page.forms[2].purposeGuess, 'search');
  assert.equal(JSON.stringify(page.forms).includes('"value"'), false);
});

test('structured data and forms are only produced when requested', () => {
  const light = plain(Extract.extractPage(doc(), { url: URL_ }));
  for (const key of ['jsonld', 'microdata', 'tables', 'lists', 'keyValue', 'forms']) assert.equal(key in light, false, key);
});

test('size caps and truncation', () => {
  const para = '<p>' + 'Sentence number one is here, and it keeps going with more words. '.repeat(40) + '</p>';
  const big = `<html><body><article>${para.repeat(40)}</article></body></html>`;
  const page = plain(Extract.extractPage(parseHtml(big), { url: 'https://big.example.org/', maxChars: 5000 }));
  assert.ok(page.text.length <= 5000);
  assert.equal(page.truncated, true);
  const defaults = plain(Extract.extractPage(parseHtml(big), { url: 'https://big.example.org/' }));
  assert.ok(defaults.text.length <= Extract.LIMITS.text);
  const rows = '<tr><td>a</td><td>b</td></tr>'.repeat(200);
  const table = plain(Extract.extractPage(parseHtml(`<body><main><p>${'text '.repeat(80)}</p><table>${rows}</table></main></body>`), { include: { structured: true } })).tables[0];
  assert.equal(table.rows.length, Extract.LIMITS.rows);
  assert.equal(table.truncated, true);
});

test('readability heuristic finds the content block on pages without <main> or <article>', () => {
  const html = `<html><body>
    <div class="menu"><a href="/a">One</a><a href="/b">Two</a><a href="/c">Three</a></div>
    <div class="content"><p>Real content starts here, with a decent amount of prose, commas, and detail to score well.</p>
    <p>A second paragraph continues the discussion, adding more substance for the scoring heuristic to find.</p></div>
    <div class="ads"><p>Buy now!</p></div></body></html>`;
  const page = plain(Extract.extractPage(parseHtml(html), { url: 'https://plain.example.org/' }));
  assert.match(page.text, /Real content starts here/);
  assert.match(page.text, /second paragraph/);
  assert.equal(page.text.includes('Buy now'), false);
  assert.equal(page.text.includes('Three'), false);
});

test('redaction: parity with the server learning redaction and extra browser patterns', () => {
  const key = 'sk-' + 'a1b2c3d4e5f6g7h8i9j0k1l2';
  const samples = [
    `Contact me@example.org or +1 415 555 0100. api_key = "${key}" ok`,
    'Authorization: Bearer abcdef1234567890abcdef',
    'postgres://admin:s3cret@db.example.org/prod',
    '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----',
    'ghp_' + 'a'.repeat(30) + ' and xoxb-1234567890-abcdefghij',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc123_-',
    'password: hunter2 and token=abcd1234',
    'jrv_' + 'a'.repeat(12) + '_' + 'B'.repeat(43),
    'plain text with no secrets, 2026-01-02 and order 42',
  ];
  for (const sample of samples) assert.equal(Redact.redactText(sample), serverRedact(sample), sample);
  assert.equal(Redact.redactText('card 4111 1111 1111 1111 ok'), 'card [REDACTED CARD] ok');
  assert.equal(Redact.redactText('4111-1111-1111-1111'), '[REDACTED CARD]');
  assert.equal(Redact.redactText('ref 1234 5678 9012 3456'), 'ref 1234 5678 9012 3456', 'non-Luhn digit runs are kept');
  assert.equal(Redact.redactText('jbk_' + 'a'.repeat(12) + '_' + 'B'.repeat(43)), '[REDACTED BROWSER KEY]');
  const deep = plain(Redact.redactDeep({ a: ['x@example.org', { b: key }], n: 3 }));
  assert.deepEqual(deep, { a: ['[REDACTED EMAIL]', { b: '[REDACTED API KEY]' }], n: 3 });
});

test('blocklist: banking, mail and health are blocked by default; ordinary sites are not', () => {
  const blocked = [
    'https://www.chase.com/personal', 'https://onlinebanking.examplebank.com/', 'https://mail.google.com/mail/u/0/', 'https://outlook.live.com/mail/',
    'https://mychart.example-hospital.org/login', 'https://www.nhs.uk/', 'https://login.paypal.com/', 'https://www.icloud.com/mail/', 'http://webmail.example.org/',
    'chrome://settings', 'about:blank', 'file:///C:/secret.txt', 'javascript:alert(1)', 'not a url', 'moz-extension://abc/panel.html',
  ];
  for (const url of blocked) assert.equal(Policy.isBlocked(url), true, url);
  for (const url of ['https://docs.example.org/guide', 'https://en.wikipedia.org/wiki/Widget', 'https://news.ycombinator.com/', 'https://www.icloud.com/photos', 'https://notchase.com/']) {
    assert.equal(Policy.isBlocked(url), false, url);
  }
});

test('blocklist: user-edited list replaces the defaults and supports path, wildcard and subdomain entries', () => {
  const list = Policy.parseBlocklist('  Corp.Example.com \n*secret*,wiki.example.org/private\n\nbad entry!\n');
  assert.deepEqual(plain(list), ['corp.example.com', '*secret*', 'wiki.example.org/private']);
  assert.equal(Policy.isBlocked('https://intranet.corp.example.com/x', list), true);
  assert.equal(Policy.isBlocked('https://my-secret-site.net/', list), true);
  assert.equal(Policy.isBlocked('https://wiki.example.org/private/page', list), true);
  assert.equal(Policy.isBlocked('https://wiki.example.org/public', list), false);
  assert.equal(Policy.isBlocked('https://www.chase.com/', list), false, 'an edited list is authoritative');
  assert.equal(Policy.isBlocked('https://www.chase.com/', []), false);
});

test('only loopback JARVIS URLs are accepted', () => {
  assert.equal(Policy.normalizeServerUrl('http://127.0.0.1:3000'), 'http://127.0.0.1:3000');
  assert.equal(Policy.normalizeServerUrl('http://localhost:3000/anything'), 'http://localhost:3000');
  assert.equal(Policy.normalizeServerUrl('http://[::1]:3000'), 'http://[::1]:3000');
  for (const bad of ['https://127.0.0.1:3000', 'http://192.168.1.5:3000', 'http://example.org', 'http://127.0.0.1.evil.example', 'http://user:pw@127.0.0.1:3000', 'ftp://127.0.0.1', '', 'nope']) {
    assert.equal(Policy.normalizeServerUrl(bad), null, bad);
  }
});

test('api client: loopback only, redacts payloads, sends the key only as a header, refuses redirects', async () => {
  const calls: Array<{ url: string; init: Record<string, any> }> = [];
  const fetchImpl = async (url: string, init: Record<string, any>) => { calls.push({ url, init }); return { ok: true, status: 200, json: async () => ({ ok: true }) }; };
  const key = 'jbk_' + 'a'.repeat(12) + '_' + 'B'.repeat(43);
  const ctx = load(['lib/redact.js', 'lib/policy.js', 'lib/api.js']);
  const client = ctx['JarvisApi'].create({ getConfig: async () => ({ serverUrl: 'http://127.0.0.1:3999', key }), fetchImpl });
  await client.request('POST', '/api/browser/ext/summarize', { page: { text: 'mail me@example.org token=abcd1234' } });
  assert.equal(calls[0]!.url, 'http://127.0.0.1:3999/api/browser/ext/summarize');
  assert.equal(calls[0]!.init['headers']['x-jarvis-browser-key'], key);
  assert.equal(calls[0]!.init['redirect'], 'error');
  assert.equal(calls[0]!.init['credentials'], 'omit');
  assert.equal(String(calls[0]!.init['body']).includes('example.org'), false);
  assert.equal(String(calls[0]!.url).includes(key), false);
  await assert.rejects(client.request('GET', '/api/studio/conversations'), /Unsupported API path/);
  await assert.rejects(client.request('GET', '/api/browser/admin/keys'), /Unsupported API path/);
  const remote = ctx['JarvisApi'].create({ getConfig: async () => ({ serverUrl: 'http://203.0.113.9:3000', key }), fetchImpl });
  await assert.rejects(remote.request('GET', '/api/browser/ext/ping'), /loopback/);
  const noKey = ctx['JarvisApi'].create({ getConfig: async () => ({ serverUrl: 'http://127.0.0.1:3000', key: '' }), fetchImpl });
  await assert.rejects(noKey.request('GET', '/api/browser/ext/ping'), /No browser key/);
  assert.equal(calls.length, 1, 'rejected requests never reach fetch');
});

test('api client parses server-sent events', async () => {
  const body = 'event: meta\ndata: {"sources":[]}\n\nevent: delta\ndata: {"text":"Hi "}\n\nevent: delta\ndata: {"text":"there"}\n\nevent: done\ndata: {"stopped":false}\n\n';
  const bytes = new TextEncoder().encode(body);
  const fetchImpl = async () => ({ ok: true, status: 200, body: { getReader() { let sent = false; return { async read() { if (sent) return { done: true }; sent = true; return { done: false, value: bytes.slice(0, 40) }; } }; } } });
  // Deliver in two chunks to exercise buffering across chunk boundaries.
  let step = 0;
  const chunked = async () => ({ ok: true, status: 200, body: { getReader: () => ({ read: async () => { step += 1; return step === 1 ? { done: false, value: bytes.slice(0, 40) } : step === 2 ? { done: false, value: bytes.slice(40) } : { done: true }; } }) } });
  void fetchImpl;
  const ctx = load(['lib/redact.js', 'lib/policy.js', 'lib/api.js']);
  const client = ctx['JarvisApi'].create({ getConfig: async () => ({ serverUrl: 'http://localhost:3000', key: 'jbk_' + 'a'.repeat(12) + '_' + 'B'.repeat(43) }), fetchImpl: chunked });
  const events: string[] = [];
  await client.stream('/api/browser/ext/chat', { question: 'x' }, (name: string, data: { text?: string }) => events.push(name + (data.text ? ':' + data.text : '')));
  assert.deepEqual(events, ['meta', 'delta:Hi ', 'delta:there', 'done']);
});

function listFiles(dir: string, prefix = ''): string[] {
  return readdirSync(dir).flatMap((name) => (statSync(join(dir, name)).isDirectory() ? listFiles(join(dir, name), `${prefix}${name}/`) : [`${prefix}${name}`]));
}

test('manifests build for both targets with minimal permissions and no <all_urls>', () => {
  assert.deepEqual([...TARGETS].sort(), ['chromium', 'firefox']);
  const chromium = plain(buildManifest('chromium'));
  const firefox = plain(buildManifest('firefox'));
  for (const manifest of [chromium, firefox]) {
    assert.equal(manifest.manifest_version, 3);
    assert.doesNotThrow(() => JSON.parse(JSON.stringify(manifest)));
    assert.equal(JSON.stringify(manifest).includes('<all_urls>'), false);
    assert.equal(manifest.content_scripts, undefined, 'no always-on content scripts');
    assert.equal(manifest.incognito, 'not_allowed');
    for (const p of ['activeTab', 'storage', 'contextMenus', 'scripting']) assert.ok(manifest.permissions.includes(p), p);
    for (const banned of ['tabs', 'history', 'cookies', 'webRequest', 'webNavigation', 'downloads', 'clipboardRead', 'bookmarks', 'nativeMessaging', '<all_urls>']) assert.equal(manifest.permissions.includes(banned), false, banned);
    assert.deepEqual(manifest.host_permissions, ['http://127.0.0.1/*', 'http://localhost/*', 'http://[::1]/*'], 'host access is loopback only');
    assert.equal(manifest.optional_permissions, undefined);
  }
  assert.ok(chromium.permissions.includes('sidePanel'));
  assert.equal(chromium.side_panel.default_path, 'panel/panel.html');
  assert.equal(chromium.background.service_worker, 'background.js');
  assert.equal(chromium.sidebar_action, undefined);
  assert.equal(chromium.browser_specific_settings, undefined);
  assert.equal(firefox.permissions.includes('sidePanel'), false);
  assert.equal(firefox.sidebar_action.default_panel, 'panel/panel.html');
  assert.deepEqual(firefox.background.scripts.slice(-1), ['background.js']);
  assert.equal(firefox.background.service_worker, undefined);
  assert.match(firefox.browser_specific_settings.gecko.id, /@/);
  assert.equal(firefox.side_panel, undefined);
  assert.throws(() => buildManifest('safari'));
});

test('build emits a Chromium and a Firefox tree whose manifests reference existing files', () => {
  const out = mkdtempSync(join(tmpdir(), 'jarvis-ext-'));
  try {
    build(out);
    for (const target of TARGETS) {
      const dir = join(out, target);
      const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
      const refs = [...Object.values(manifest.icons), manifest.side_panel?.default_path, manifest.sidebar_action?.default_panel, manifest.background.service_worker, ...(manifest.background.scripts ?? [])].filter(Boolean) as string[];
      for (const ref of refs) assert.ok(existsSync(join(dir, ref)), `${target}: ${ref}`);
      const files = listFiles(dir);
      for (const required of ['background.js', 'lib/extract.js', 'lib/redact.js', 'lib/policy.js', 'lib/api.js', 'panel/panel.html', 'panel/panel.js', 'panel/panel.css']) assert.ok(files.includes(required), required);
      assert.equal(JSON.stringify(manifest).includes('<all_urls>'), false);
    }
    assert.equal(readFileSync(join(out, 'chromium/icons/icon-48.png')).subarray(1, 4).toString(), 'PNG');
  } finally { rmSync(out, { recursive: true, force: true }); }
});

test('extension sources: no all-urls access, no innerHTML, no remote code, no secrets', () => {
  const sources = listFiles(join(root, 'src')).filter((f) => /\.(js|html|css)$/.test(f));
  assert.ok(sources.length >= 8);
  for (const file of sources) {
    const text = readFileSync(join(root, 'src', file), 'utf8');
    assert.equal(text.includes('<all_urls>'), false, file);
    assert.equal(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function\(/.test(text), false, `${file} uses an unsafe DOM/eval API`);
    assert.equal(/https?:\/\/(?!127\.0\.0\.1|localhost|schema\.org|www\.w3\.org|journal\.example)[a-z0-9.-]+\.[a-z]{2,}\//i.test(text.replace(/^\s*\/?\*.*$/gm, '').replace(/\/\/.*$/gm, '')), false, `${file} references a remote host`);
    assert.equal(/jbk_[a-f0-9]{12}_[A-Za-z0-9_-]{43}/.test(text), false, `${file} embeds a key`);
  }
  assert.equal(/<script[^>]+src="https?:/i.test(readFileSync(join(root, 'src/panel/panel.html'), 'utf8')), false);
  assert.equal(/executeScript|insertCSS/.test(readFileSync(join(root, 'src/panel/panel.js'), 'utf8')), false, 'only the background script injects the reader');
});
