/*
 * JARVIS browser extension: side panel / sidebar UI (E3:D4.21).
 * All content is rendered with textContent only. The browser key lives only here and in
 * extension storage; it is never passed to a content script or shown in page context.
 */
(function () {
  'use strict';
  var ext = globalThis.browser || globalThis.chrome;
  var Policy = self.JarvisPolicy;
  var $ = function (id) { return document.getElementById(id); };
  var KEY_SESSION = 'jarvisBrowserKey';
  var busy = false, controller = null, turns = [], currentPage = null;

  // ---------------- settings and key storage ----------------

  async function loadConfig() {
    var local = await ext.storage.local.get({ serverUrl: 'http://127.0.0.1:3000', blocklist: null, saveVisited: true, rememberKey: false, persistedKey: '' });
    var session = ext.storage.session ? await ext.storage.session.get({ jarvisBrowserKey: '' }) : { jarvisBrowserKey: '' };
    return {
      serverUrl: local.serverUrl, blocklist: Array.isArray(local.blocklist) ? local.blocklist : Policy.DEFAULT_BLOCKLIST,
      saveVisited: local.saveVisited !== false, rememberKey: local.rememberKey === true, key: session[KEY_SESSION] || local.persistedKey || ''
    };
  }

  var api = self.JarvisApi.create({ getConfig: async function () { var c = await loadConfig(); return { serverUrl: c.serverUrl, key: c.key }; } });

  function setStatus(text, ok) { var s = $('status'); s.textContent = text; s.className = 'status' + (ok ? ' ok' : ''); }
  function notice(text) { var n = $('notice'); n.textContent = text || ''; n.hidden = !text; }

  async function renderSettings() {
    var c = await loadConfig();
    $('serverUrl').value = c.serverUrl;
    $('keyInput').value = '';
    $('keyInput').placeholder = c.key ? 'A key is saved (hidden). Paste a new one to replace it.' : 'jbk_...';
    $('rememberKey').checked = c.rememberKey;
    $('saveVisited').checked = c.saveVisited;
    $('blocklist').value = c.blocklist.join('\n');
    if (!c.key) { setStatus('No key set', false); $('settings').open = true; }
  }

  async function saveConnection() {
    var origin = Policy.normalizeServerUrl($('serverUrl').value);
    if (!origin) { notice('Only a loopback JARVIS URL such as http://127.0.0.1:3000 is allowed.'); return; }
    var key = $('keyInput').value.trim();
    var remember = $('rememberKey').checked;
    var patch = { serverUrl: origin, rememberKey: remember, saveVisited: $('saveVisited').checked };
    if (key) {
      if (!/^jbk_[a-f0-9]{12}_[A-Za-z0-9_-]{43}$/.test(key)) { notice('That does not look like a JARVIS browser key (jbk_...).'); return; }
      if (ext.storage.session) await ext.storage.session.set({ jarvisBrowserKey: key });
      patch.persistedKey = remember || !ext.storage.session ? key : '';
    } else if (!remember) patch.persistedKey = '';
    await ext.storage.local.set(patch);
    notice('');
    await renderSettings();
    await testConnection();
  }

  async function forgetKey() {
    if (ext.storage.session) await ext.storage.session.remove(KEY_SESSION);
    await ext.storage.local.remove('persistedKey');
    $('keyInput').value = '';
    sessions = [];
    renderSessions();
    await renderSettings();
    setStatus('Key forgotten', false);
  }

  async function testConnection() {
    try { await api.request('GET', '/api/browser/ext/ping'); setStatus('Connected to JARVIS', true); notice(''); await loadSessions(); }
    catch (e) { setStatus('Not connected', false); notice(e.message); }
  }

  // ---------------- chat log ----------------

  function addMessage(kind, text) {
    var el = document.createElement('div');
    el.className = 'msg ' + kind;
    el.textContent = text;
    $('log').appendChild(el);
    el.scrollIntoView({ block: 'end' });
    return el;
  }

  function addSources(el, sources) {
    if (!sources || !sources.length) return;
    var s = document.createElement('span');
    s.className = 'src';
    s.textContent = 'Sources: ' + sources.map(function (x) { return '[' + x.ref + '] ' + (x.title || x.url) + ' (' + x.url + ')'; }).join('; ');
    el.appendChild(s);
  }

  function setBusy(value) {
    busy = value;
    document.querySelectorAll('.actions button, #askSend').forEach(function (b) { b.disabled = value; });
    $('askStop').hidden = !value;
  }

  // ---------------- reading the page (always on a user action) ----------------

  async function activeTabId() {
    var tabs = await ext.tabs.query({ active: true, lastFocusedWindow: true, windowType: 'normal' });
    return tabs[0] && tabs[0].id;
  }

  async function readCurrent(include) {
    var tabId = await activeTabId();
    if (tabId === undefined) { notice('No active tab found.'); return null; }
    var result = await ext.runtime.sendMessage({ type: 'read-page', tabId: tabId, include: include || {} });
    if (!result || !result.ok) { notice(result ? result.message : 'Reading the page failed.'); return null; }
    notice('');
    currentPage = result.page;
    $('pageTitle').textContent = result.page.title || '(untitled page)';
    $('pageUrl').textContent = result.page.url + (result.page.truncated ? ' (long page: first part read)' : '');
    return result.page;
  }

  function pagePayload(page) {
    return { url: page.url, title: page.title, text: page.text, headings: page.headings.map(function (h) { return h.text; }), meta: page.meta };
  }

  // ---------------- sessions (stored in JARVIS) ----------------

  var sessions = [];

  function selectedSession() { return $('sessionSelect').value || undefined; }

  function renderSessions() {
    var select = $('sessionSelect'), previous = select.value;
    select.textContent = '';
    var none = document.createElement('option'); none.value = ''; none.textContent = 'None'; select.appendChild(none);
    sessions.forEach(function (s) {
      var o = document.createElement('option'); o.value = s.id; o.textContent = s.name + ' (' + s.tabs.length + ')'; select.appendChild(o);
    });
    if (sessions.some(function (s) { return s.id === previous; })) select.value = previous;
    renderSessionTabs();
  }

  function renderSessionTabs() {
    var list = $('sessionTabs');
    list.textContent = '';
    var s = sessions.filter(function (x) { return x.id === selectedSession(); })[0];
    if (!s) return;
    s.tabs.forEach(function (t) {
      var li = document.createElement('li');
      li.textContent = (t.title || t.url) + ' ';
      var rm = document.createElement('button');
      rm.type = 'button'; rm.className = 'small'; rm.textContent = 'Remove';
      rm.addEventListener('click', async function () {
        try { await api.request('POST', '/api/browser/ext/sessions/' + s.id + '/tabs/remove', { url: t.url }); await loadSessions(); } catch (e) { notice(e.message); }
      });
      li.appendChild(rm);
      list.appendChild(li);
    });
  }

  async function loadSessions() {
    try { sessions = (await api.request('GET', '/api/browser/ext/sessions')).sessions; renderSessions(); } catch (e) { /* surfaced by testConnection */ }
  }

  function newSession() { $('sessionNameRow').hidden = false; $('sessionName').focus(); }

  async function createSession() {
    var name = $('sessionName').value.trim();
    if (!name) return;
    try {
      var r = await api.request('POST', '/api/browser/ext/sessions', { name: name });
      $('sessionName').value = ''; $('sessionNameRow').hidden = true;
      await loadSessions(); $('sessionSelect').value = r.session.id; renderSessionTabs();
    } catch (e) { notice(e.message); }
  }

  async function addTab() {
    var id = selectedSession();
    if (!id) { notice('Choose or create a research session first.'); return; }
    var page = await readCurrent({});
    if (!page) return;
    try {
      await api.request('POST', '/api/browser/ext/sessions/' + id + '/tabs', { page: pagePayload(page) });
      addMessage('bot', 'Added "' + (page.title || page.url) + '" to the session. JARVIS now links context across its tabs.');
      await loadSessions();
    } catch (e) { notice(e.message); }
  }

  async function deleteSession() {
    var id = selectedSession();
    if (!id) return;
    if ($('sessionDelete').dataset.armed !== id) { $('sessionDelete').dataset.armed = id; $('sessionDelete').textContent = 'Confirm delete'; return; }
    $('sessionDelete').dataset.armed = ''; $('sessionDelete').textContent = 'Delete';
    try { await api.request('DELETE', '/api/browser/ext/sessions/' + id); await loadSessions(); } catch (e) { notice(e.message); }
  }

  // ---------------- actions ----------------

  async function runAction(action, question) {
    if (busy) return;
    setBusy(true);
    try {
      var include = action === 'extract' ? { structured: true } : action === 'analyze-form' ? { forms: true } : {};
      var page = await readCurrent(include);
      if (!page) return;
      var cfg = await loadConfig();
      var body = { page: pagePayload(page), save: cfg.saveVisited };
      var sessionId = selectedSession();
      if (sessionId) body.sessionId = sessionId;
      if (question) body.question = question;
      if (action === 'explain') {
        if (page.selection) body.selection = page.selection;
        addMessage('user', 'Explain ' + (page.selection ? 'the selection' : 'this page'));
      } else if (action === 'extract') {
        body.structured = { jsonld: page.jsonld, microdata: page.microdata, tables: page.tables, lists: page.lists, keyValue: page.keyValue, links: page.links.slice(0, 20) };
        addMessage('user', 'Extract structured data');
      } else if (action === 'analyze-form') {
        if (!page.forms || !page.forms.length) { addMessage('bot', 'No forms were found on this page.'); return; }
        body.forms = page.forms;
        addMessage('user', 'Analyze the form' + (page.forms.length > 1 ? 's' : ''));
      } else if (action === 'summarize') addMessage('user', 'Summarize this page');
      var result = await api.request('POST', '/api/browser/ext/' + action, body);
      var el = addMessage('bot', result.result);
      addSources(el, result.sources);
      if (action === 'extract') attachRaw(el, body.structured);
      if (action === 'analyze-form') attachRaw(el, page.forms, 'Fields found (no values read)');
      setStatus('Connected to JARVIS', true);
    } catch (e) {
      addMessage('err', e.message);
    } finally { setBusy(false); }
  }

  function attachRaw(el, data, label) {
    var details = document.createElement('details');
    var summary = document.createElement('summary'); summary.textContent = label || 'Raw structured data'; details.appendChild(summary);
    var pre = document.createElement('pre'); pre.textContent = JSON.stringify(data, null, 2); details.appendChild(pre);
    el.appendChild(details);
  }

  async function ask(question) {
    if (busy || !question.trim()) return;
    setBusy(true);
    controller = new AbortController();
    try {
      var page = await readCurrent({});
      if (!page) return;
      var cfg = await loadConfig();
      addMessage('user', question);
      var bot = addMessage('bot', '');
      var body = { question: question, pages: [pagePayload(page)], save: cfg.saveVisited, history: turns.slice(-8) };
      var sessionId = selectedSession();
      if (sessionId) body.sessionId = sessionId;
      var reply = '', sources = [];
      await api.stream('/api/browser/ext/chat', body, function (event, data) {
        if (event === 'meta') sources = data.sources || [];
        else if (event === 'delta') { reply += data.text; bot.textContent = reply; bot.scrollIntoView({ block: 'end' }); }
        else if (event === 'error') { bot.classList.add('err'); bot.textContent = data.error; }
        else if (event === 'done') addSources(bot, sources);
      }, controller.signal);
      if (reply) { turns.push({ role: 'user', content: question }, { role: 'assistant', content: reply }); }
      $('askInput').value = '';
    } catch (e) {
      if (!e || e.name !== 'AbortError') addMessage('err', e.message);
    } finally { controller = null; setBusy(false); }
  }

  async function loadHistory() {
    var list = $('history');
    list.textContent = '';
    try {
      var h = (await api.request('GET', '/api/browser/ext/history?limit=20')).history;
      if (!h.length) { var empty = document.createElement('li'); empty.textContent = 'No research history yet.'; list.appendChild(empty); }
      h.forEach(function (x) {
        var li = document.createElement('li');
        li.textContent = x.at.slice(0, 16).replace('T', ' ') + ' [' + x.kind + '] ' + (x.title || x.url || '') + (x.question ? ': ' + x.question : '');
        list.appendChild(li);
      });
    } catch (e) { notice(e.message); }
  }

  async function clearHistory() {
    if ($('historyClear').dataset.armed !== '1') { $('historyClear').dataset.armed = '1'; $('historyClear').textContent = 'Confirm clear'; return; }
    $('historyClear').dataset.armed = ''; $('historyClear').textContent = 'Clear research history';
    try { await api.request('DELETE', '/api/browser/ext/history'); $('history').textContent = ''; } catch (e) { notice(e.message); }
  }

  // ---------------- wiring ----------------

  async function consumeQueued() {
    var area = ext.storage.session || ext.storage.local;
    var stored = await area.get({ jarvisQueued: null });
    var task = stored.jarvisQueued;
    if (!task || Date.now() - task.at > 30000) return;
    await area.remove('jarvisQueued');
    if (task.action === 'focus-ask') $('askInput').focus();
    else if (task.action) runAction(task.action);
  }

  document.querySelectorAll('.actions button').forEach(function (b) { b.addEventListener('click', function () { runAction(b.dataset.action); }); });
  $('askForm').addEventListener('submit', function (e) { e.preventDefault(); ask($('askInput').value); });
  $('askStop').addEventListener('click', function () { if (controller) controller.abort(); });
  $('clearLog').addEventListener('click', function () { $('log').textContent = ''; turns = []; });
  $('keySave').addEventListener('click', saveConnection);
  $('keyForget').addEventListener('click', forgetKey);
  $('testConn').addEventListener('click', testConnection);
  $('sessionNew').addEventListener('click', newSession);
  $('sessionCreate').addEventListener('click', createSession);
  $('sessionName').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); createSession(); } });
  $('sessionAdd').addEventListener('click', addTab);
  $('sessionDelete').addEventListener('click', deleteSession);
  $('sessionSelect').addEventListener('change', renderSessionTabs);
  $('historyLoad').addEventListener('click', loadHistory);
  $('historyClear').addEventListener('click', clearHistory);
  $('blocklistSave').addEventListener('click', async function () {
    await ext.storage.local.set({ blocklist: Policy.parseBlocklist($('blocklist').value) });
    await renderSettings(); notice('');
  });
  $('blocklistReset').addEventListener('click', async function () { await ext.storage.local.remove('blocklist'); await renderSettings(); });
  ext.storage.onChanged.addListener(function (changes) { if (changes.jarvisQueued && changes.jarvisQueued.newValue) consumeQueued(); });

  renderSettings().then(function () { return testConnection(); }).then(consumeQueued);
})();
