// JARVIS Studio shell: chat, API keys and learning. Vanilla ES module, no framework.
// Security notes: every request is a device-signed request (JarvisDeviceCrypto);
// model output is rendered with createElement/textContent only (never raw HTML);
// API keys live only in a local variable while shown once and are never put in
// browser storage, the URL or the console.
import { parseMarkdown } from '/studio/markdown.js';
import { isValidTotpCode, withStepUp } from '/studio/stepup.js';

const OWNER_PERMISSION = 'device:manage:execute';
const $ = (id) => document.getElementById(id);

/** Create an element. attrs: class, text, on* handlers, and plain attributes. */
function h(tag, attrs = {}, children = []) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') element.className = value;
    else if (key === 'text') element.textContent = value;
    else if (key.startsWith('on') && typeof value === 'function') element.addEventListener(key.slice(2), value);
    else element.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    element.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return element;
}

const state = {
  conversations: [],
  current: null, // full conversation object
  view: 'chat',
  models: [],
  defaultModel: '',
  streaming: null, // { controller, conversationId }
  config: { gatewayUrl: null },
  attachments: [],
  search: '',
};

// ---------- storage (per-viewer convenience only; never secrets) ----------
const prefs = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* storage may be blocked */ } },
};

// ---------- API ----------
async function api(path, { method = 'GET', body, signal } = {}) {
  const crypto = window.JarvisDeviceCrypto;
  if (!crypto?.signedFetch) throw new Error('Secure device session unavailable');
  const response = await crypto.signedFetch(path, { method, ...(body !== undefined ? { body } : {}), ...(signal ? { signal } : {}) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || data.message || `Request failed (HTTP ${response.status})`);
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}

function notice(message, kind = '') {
  const box = $('notice');
  if (!message) { box.hidden = true; return; }
  box.textContent = message;
  box.className = 'notice ' + kind;
  box.hidden = false;
}

async function copyText(text, button) {
  try {
    await navigator.clipboard.writeText(text);
    if (button) { const old = button.textContent; button.textContent = 'Copied'; setTimeout(() => { button.textContent = old; }, 1400); }
  } catch {
    notice('Copy was blocked by the browser. Select the text and copy it manually.', 'error');
  }
}

// ---------- dialogs ----------
function askText({ title, body = '', value = '', confirmOnly = false, okLabel = 'OK' }) {
  const dialog = $('text-dialog');
  $('text-dialog-title').textContent = title;
  $('text-dialog-body').textContent = body;
  const input = $('text-dialog-input');
  input.hidden = confirmOnly;
  input.value = value;
  $('text-dialog-ok').textContent = okLabel;
  return new Promise((resolve) => {
    const finish = (result) => { dialog.removeEventListener('close', onClose); resolve(result); };
    const onClose = () => finish(dialog.returnValue === 'ok' ? (confirmOnly ? true : input.value.trim()) : null);
    dialog.addEventListener('close', onClose);
    dialog.returnValue = '';
    dialog.showModal();
    (confirmOnly ? $('text-dialog-ok') : input).focus();
  });
}
const confirmAction = (title, body, okLabel = 'Confirm') => askText({ title, body, confirmOnly: true, okLabel });

// ---------- authenticator step-up ----------
function askTotpCode(error) {
  const dialog = $('totp-dialog');
  const input = $('totp-input');
  const box = $('totp-error');
  box.textContent = error || '';
  box.hidden = !error;
  input.value = '';
  return new Promise((resolve) => {
    const onClose = () => {
      dialog.removeEventListener('close', onClose);
      const code = dialog.returnValue === 'ok' && isValidTotpCode(input.value) ? input.value.trim() : null;
      input.value = ''; // the code is never kept
      resolve(code);
    };
    dialog.addEventListener('close', onClose);
    dialog.returnValue = '';
    dialog.showModal();
    input.focus();
  });
}

/** POST a step-up action; when TOTP is enabled, ask for a fresh code and send it as totpCode. */
function stepUpPost(path, body = {}) {
  return withStepUp({
    getStatus: async () => (await api('/api/security/totp/status')).status,
    askCode: askTotpCode,
    send: (payload) => api(path, { method: 'POST', body: payload }),
  }, body);
}

// ---------- date grouping ----------
function groupLabel(timestamp) {
  const day = 86_400_000;
  const startOfToday = new Date().setHours(0, 0, 0, 0);
  if (timestamp >= startOfToday) return 'Today';
  if (timestamp >= startOfToday - day) return 'Yesterday';
  if (timestamp >= startOfToday - 7 * day) return 'Previous 7 days';
  if (timestamp >= startOfToday - 30 * day) return 'Previous 30 days';
  return 'Older';
}

// ---------- markdown rendering (DOM nodes only) ----------
function renderInline(nodes, parent) {
  for (const node of nodes) {
    if (node.type === 'text') parent.append(document.createTextNode(node.value));
    else if (node.type === 'code') parent.append(h('code', { text: node.value }));
    else if (node.type === 'strong' || node.type === 'em') {
      const element = h(node.type);
      renderInline(node.children, element);
      parent.append(element);
    } else if (node.type === 'link') {
      const link = h('a', { href: node.href, target: '_blank', rel: 'noopener noreferrer nofollow' });
      renderInline(node.children, link);
      parent.append(link);
    }
  }
}

function codeBlock(block) {
  const code = h('code', { text: block.value });
  return h('div', { class: 'codeblock' }, [
    h('div', { class: 'codeblock-head' }, [
      h('span', { text: block.lang || 'text' }),
      h('button', { type: 'button', class: 'btn small', 'aria-label': 'Copy code', text: 'Copy', onclick: (event) => copyText(block.value, event.currentTarget) }),
    ]),
    h('pre', { tabindex: '0' }, [code]),
  ]);
}

function renderBlocks(blocks, parent) {
  for (const block of blocks) {
    if (block.type === 'code') parent.append(codeBlock(block));
    else if (block.type === 'hr') parent.append(h('hr'));
    else if (block.type === 'quote') { const quote = h('blockquote'); renderBlocks(block.children, quote); parent.append(quote); }
    else if (block.type === 'ul' || block.type === 'ol') {
      const list = h(block.type);
      for (const item of block.items) { const li = h('li'); renderInline(item, li); list.append(li); }
      parent.append(list);
    } else if (block.type === 'h') {
      const heading = h('h' + Math.min(4, block.level));
      renderInline(block.children, heading);
      parent.append(heading);
    } else {
      const paragraph = h('p');
      renderInline(block.children, paragraph);
      parent.append(paragraph);
    }
  }
}

function renderMarkdownInto(container, text) {
  container.replaceChildren();
  renderBlocks(parseMarkdown(text), container);
}

// ---------- sidebar ----------
async function loadConversations() {
  const query = state.search ? '?q=' + encodeURIComponent(state.search) : '';
  const data = await api('/api/studio/conversations' + query);
  state.conversations = data.conversations;
  renderConversationList();
}

function renderConversationList() {
  const list = $('conversation-list');
  list.replaceChildren();
  if (!state.conversations.length) {
    list.append(h('p', { class: 'muted small', text: state.search ? 'No matching conversations.' : 'No conversations yet.' }));
    return;
  }
  let lastGroup = '';
  for (const conversation of state.conversations) {
    const group = groupLabel(conversation.updatedAt);
    if (group !== lastGroup) { list.append(h('div', { class: 'group-label', role: 'presentation', text: group })); lastGroup = group; }
    const active = state.current?.id === conversation.id;
    list.append(h('div', { class: 'conv', role: 'listitem', 'data-active': active ? 'true' : 'false' }, [
      h('button', { type: 'button', class: 'conv-open', title: conversation.title, 'aria-current': active ? 'true' : null, text: conversation.title, onclick: () => openConversation(conversation.id) }),
      h('div', { class: 'conv-actions' }, [
        h('button', { type: 'button', 'aria-label': 'Rename ' + conversation.title, text: 'Rename', onclick: () => renameConversation(conversation) }),
        h('button', { type: 'button', 'aria-label': 'Delete ' + conversation.title, text: 'Delete', onclick: () => deleteConversation(conversation) }),
      ]),
    ]));
  }
}

async function renameConversation(conversation) {
  const title = await askText({ title: 'Rename conversation', value: conversation.title, okLabel: 'Rename' });
  if (!title) return;
  try {
    await api('/api/studio/conversations/' + conversation.id, { method: 'PATCH', body: { title } });
    if (state.current?.id === conversation.id) state.current.title = title;
    await loadConversations();
  } catch (error) { notice(error.message, 'error'); }
}

async function deleteConversation(conversation) {
  if (!await confirmAction('Delete conversation?', `"${conversation.title}" will be permanently deleted.`, 'Delete')) return;
  try {
    await api('/api/studio/conversations/' + conversation.id, { method: 'DELETE' });
    if (state.current?.id === conversation.id) { state.current = null; renderThread(); }
    await loadConversations();
  } catch (error) { notice(error.message, 'error'); }
}

// ---------- chat ----------
function renderMessage(message) {
  const assistant = message.role === 'assistant';
  const body = h('div', { class: 'msg-body' });
  if (assistant) renderMarkdownInto(body, message.content); else body.textContent = message.content;
  const node = h('article', { class: 'msg ' + message.role, 'data-id': message.id || '' }, [
    h('div', { class: 'msg-role', text: assistant ? 'JARVIS' : 'You' }),
    body,
  ]);
  if (assistant && message.id) node.append(messageActions(message));
  return node;
}

function messageActions(message) {
  const rate = (rating) => rateMessage(message, rating);
  const up = h('button', { type: 'button', class: 'btn small rate-btn', 'aria-label': 'Good reply', 'aria-pressed': message.rating === 'up' ? 'true' : 'false', text: 'Good', onclick: () => rate('up') });
  const down = h('button', { type: 'button', class: 'btn small rate-btn', 'aria-label': 'Bad reply', 'aria-pressed': message.rating === 'down' ? 'true' : 'false', text: 'Bad', onclick: () => rate('down') });
  const meta = [];
  if (message.model) meta.push(message.model);
  if (message.stopped) meta.push('stopped');
  if (message.sources?.length) meta.push(message.sources.length + ' context item' + (message.sources.length === 1 ? '' : 's'));
  return h('div', { class: 'msg-actions' }, [
    h('button', { type: 'button', class: 'btn small', text: 'Copy', onclick: (event) => copyText(message.content, event.currentTarget) }),
    up, down,
    h('span', { class: 'msg-meta', text: meta.join(' - '), title: (message.sources || []).join('\n') }),
  ]);
}

async function rateMessage(message, rating) {
  const next = message.rating === rating ? null : rating;
  try {
    await api(`/api/studio/conversations/${state.current.id}/rate`, { method: 'POST', body: { messageId: message.id, rating: next } });
    message.rating = next ?? undefined;
    // Feedback becomes a pending learning candidate; nothing is learned until the owner approves it.
    if (next) {
      const excerpt = message.content.replace(/\s+/g, ' ').slice(0, 200);
      const content = next === 'up' ? `Owner liked this style of reply: "${excerpt}"` : `Owner disliked this style of reply: "${excerpt}"`;
      try {
        await api('/api/memory/feedback', { method: 'POST', body: { category: 'preference', content, ref: `studio:${state.current.id}` } });
        notice('Feedback saved as a learning candidate. Review it on the Learning page.', 'ok');
      } catch (error) {
        notice(error.status === 409 ? 'Rating saved. A similar memory already exists.' : 'Rating saved. Learning candidate not created: ' + error.message, error.status === 409 ? 'ok' : 'error');
      }
    } else notice('');
    renderThread();
  } catch (error) { notice(error.message, 'error'); }
}

function renderThread() {
  const thread = $('thread');
  thread.replaceChildren();
  const conversation = state.current;
  $('train-toggle-wrap').hidden = !conversation;
  $('train-toggle').checked = Boolean(conversation?.useForTraining);
  $('view-title').textContent = state.view === 'chat' ? (conversation?.title || 'Chat') : $('view-title').textContent;
  if (!conversation || !conversation.messages.length) {
    thread.append($('empty-state') || emptyState());
    $('empty-state').hidden = false;
    return;
  }
  for (const message of conversation.messages) thread.append(renderMessage(message));
  thread.scrollTop = thread.scrollHeight;
}

function emptyState() {
  return h('div', { id: 'empty-state', class: 'empty-state' }, [h('h3', { text: 'How can I help?' })]);
}

async function openConversation(id) {
  if (state.streaming) { notice('Stop the current reply before switching conversations.', 'error'); return; }
  try {
    state.current = (await api('/api/studio/conversations/' + id)).conversation;
    setView('chat');
    renderThread();
    renderConversationList();
    closeSidebar();
    $('prompt').focus();
  } catch (error) { notice(error.message, 'error'); }
}

async function newChat() {
  if (state.streaming) return;
  state.current = null;
  setView('chat');
  renderThread();
  renderConversationList();
  closeSidebar();
  $('prompt').focus();
}

function setStreamingUi(active) {
  $('send').hidden = active;
  $('stop').hidden = !active;
  $('thread').setAttribute('aria-busy', active ? 'true' : 'false');
}

function autosize() {
  const prompt = $('prompt');
  prompt.style.height = 'auto';
  prompt.style.height = Math.min(prompt.scrollHeight, 220) + 'px';
}

/** Parse a Server-Sent Events stream from a fetch Response body. */
async function* readSse(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (value) buffer += decoder.decode(value, { stream: true });
    let boundary;
    while ((boundary = buffer.indexOf('\n\n')) >= 0) {
      const raw = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      let event = 'message';
      const data = [];
      for (const line of raw.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
      }
      if (data.length) { try { yield { event, data: JSON.parse(data.join('\n')) }; } catch { /* ignore malformed frame */ } }
    }
    if (done) break;
  }
}

async function sendMessage(text) {
  if (state.streaming) return;
  if (!state.current) {
    const created = await api('/api/studio/conversations', { method: 'POST', body: {} });
    state.current = created.conversation;
  }
  const conversation = state.current;
  const userMessage = { role: 'user', content: text, id: '' };
  conversation.messages.push(userMessage);
  $('empty-state')?.remove();
  const thread = $('thread');
  thread.append(renderMessage(userMessage));
  const body = h('div', { class: 'msg-body cursor' });
  const live = h('article', { class: 'msg assistant' }, [h('div', { class: 'msg-role', text: 'JARVIS' }), body]);
  thread.append(live);
  thread.scrollTop = thread.scrollHeight;

  const controller = new AbortController();
  state.streaming = { controller, conversationId: conversation.id };
  setStreamingUi(true);
  notice('');
  let reply = '';
  let frame = 0;
  const paint = () => { frame = 0; renderMarkdownInto(body, reply); thread.scrollTop = thread.scrollHeight; };
  try {
    const response = await window.JarvisDeviceCrypto.signedFetch(`/api/studio/conversations/${conversation.id}/send`, {
      method: 'POST', body: { text, ...($('model-select').value ? { model: $('model-select').value } : {}) }, signal: controller.signal,
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(response.status === 429 ? `Rate limit reached. Try again in ${data.retryAfterSeconds || 'a few'} seconds.` : data.error || `Request failed (HTTP ${response.status})`);
    }
    for await (const { event, data } of readSse(response)) {
      if (event === 'delta') { reply += data.text; if (!frame) frame = requestAnimationFrame(paint); }
      else if (event === 'error') notice(data.error, 'error');
    }
  } catch (error) {
    if (error.name !== 'AbortError') notice(error.message, 'error');
  } finally {
    if (frame) cancelAnimationFrame(frame);
    state.streaming = null;
    setStreamingUi(false);
    body.classList.remove('cursor');
    try {
      state.current = (await api('/api/studio/conversations/' + conversation.id)).conversation;
    } catch { /* keep the local view */ }
    renderThread();
    loadConversations().catch(() => undefined);
    $('prompt').focus();
  }
}

async function stopStreaming() {
  const active = state.streaming;
  if (!active) return;
  active.controller.abort();
  api(`/api/studio/conversations/${active.conversationId}/abort`, { method: 'POST', body: {} }).catch(() => undefined);
}

async function attachFile(file) {
  if (!file) return;
  if (file.size > 15 * 1024 * 1024) { notice('Files are limited to 15 MB.', 'error'); return; }
  const chip = h('span', { class: 'chip', text: `Reading ${file.name}...` });
  $('attachments').append(chip);
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    const result = await api('/api/documents/ingest-file', { method: 'POST', body: { sourceName: file.name, documentBase64: btoa(binary) } });
    chip.textContent = `${file.name} - indexed (${result.chunkCount ?? '?'} chunks${result.duplicate ? ', already stored' : ''})`;
  } catch (error) {
    chip.textContent = `${file.name} - failed`;
    notice('Attach failed: ' + error.message, 'error');
  }
}

async function loadModels() {
  const select = $('model-select');
  try {
    const data = await api('/api/studio/models');
    state.models = data.models;
    state.defaultModel = data.default || '';
  } catch { state.models = []; }
  const names = [...new Set([state.defaultModel, ...state.models].filter(Boolean))];
  select.replaceChildren(...(names.length ? names.map((name) => h('option', { value: name, text: name })) : [h('option', { value: '', text: 'No local model found' })]));
  const saved = prefs.get('studio.model');
  if (saved && names.includes(saved)) select.value = saved;
}

// ---------- API keys view ----------
let revealedKey = null; // lives only here, and only until dismissed

function snippets(url) {
  const base = url || 'http://127.0.0.1:<gateway-port>/v1';
  return [
    ['OpenAI SDK (Python)', `from openai import OpenAI\n\nclient = OpenAI(base_url="${base}", api_key="YOUR_SITE_KEY")\nreply = client.chat.completions.create(\n    model="jarvis",\n    messages=[{"role": "user", "content": "Hello"}],\n)\nprint(reply.choices[0].message.content)`],
    ['OpenAI SDK (JavaScript)', `import OpenAI from "openai";\n\nconst client = new OpenAI({ baseURL: "${base}", apiKey: process.env.JARVIS_SITE_KEY });\nconst reply = await client.chat.completions.create({\n  model: "jarvis",\n  messages: [{ role: "user", content: "Hello" }],\n});\nconst text = reply.choices[0].message.content;`],
    ['curl', `curl ${base}/chat/completions \\\n  -H "Authorization: Bearer $JARVIS_SITE_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '{"model":"jarvis","messages":[{"role":"user","content":"Hello"}]}'`],
  ];
}

function fmtDate(value) {
  if (!value) return 'never';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'unknown' : date.toLocaleString();
}

async function approveTask(approvalId, button) {
  button.disabled = true;
  try {
    const result = await stepUpPost('/api/approval/approve', { approvalId });
    return result;
  } finally { button.disabled = false; }
}

async function mountKeys() {
  const root = $('keys-view');
  const inner = h('div', { class: 'view-inner stack' });
  root.replaceChildren(inner);
  let sites = { sites: [], pendingReveals: [] };
  try {
    [sites, state.config] = await Promise.all([api('/api/gateway/sites'), api('/api/studio/config')]);
  } catch (error) {
    inner.append(h('div', { class: 'notice error', text: 'Could not load API keys: ' + error.message }));
    return;
  }
  const status = h('p', { class: 'muted', role: 'status', 'aria-live': 'polite' });

  const secretBox = h('div', { class: 'card', hidden: true, role: 'alert' });
  const showSecret = (key) => {
    revealedKey = key;
    const code = h('code', { class: 'secret', text: key });
    secretBox.replaceChildren(
      h('h3', { text: 'Your new API key' }),
      h('p', { text: 'Copy it now. It is shown exactly once and cannot be recovered; only a hash is stored.' }),
      code,
      h('div', { class: 'row' }, [
        h('button', { type: 'button', class: 'btn primary', text: 'Copy key', onclick: (event) => copyText(revealedKey, event.currentTarget) }),
        h('button', { type: 'button', class: 'btn', text: 'I have saved it; hide', onclick: () => { revealedKey = null; secretBox.replaceChildren(); secretBox.hidden = true; mountKeys(); } }),
      ]),
    );
    secretBox.hidden = false;
    secretBox.scrollIntoView({ block: 'nearest' });
  };

  const create = h('div', { class: 'card stack' }, [
    h('h3', { text: 'Create a key' }),
    h('p', { class: 'muted', text: 'Keys let a website or script call your local model through the OpenAI-compatible JARVIS gateway. Creating a key is a high-risk action and needs your approval.' }),
  ]);
  const nameInput = h('input', { type: 'text', id: 'key-name', maxlength: '60', placeholder: 'Key name (for example: my-portfolio)' });
  const approvalBox = h('div', { class: 'stack' });
  const createButton = h('button', { type: 'button', class: 'btn primary', text: 'Create key (needs approval)' });
  createButton.addEventListener('click', async () => {
    const name = nameInput.value.trim();
    if (!name) { status.textContent = 'Enter a name first.'; return; }
    createButton.disabled = true;
    try {
      const result = await api('/api/panels/run', { method: 'POST', body: { operation: 'gateway:site_create', parameters: { name } } });
      if (result.approvalId) {
        approvalBox.replaceChildren(h('p', { text: 'Approval required to create this key.' }), approvalButtons(result.approvalId));
        status.textContent = '';
      } else { status.textContent = result.message || 'Request submitted.'; await revealPending(); }
    } catch (error) { status.textContent = error.message; } finally { createButton.disabled = false; }
  });
  const approvalButtons = (approvalId) => {
    const approve = h('button', { type: 'button', class: 'btn primary', text: 'Approve' });
    const reject = h('button', { type: 'button', class: 'btn', text: 'Reject' });
    approve.addEventListener('click', async () => {
      try { await approveTask(approvalId, approve); approvalBox.replaceChildren(); status.textContent = 'Approved.'; await revealPending(); } catch (error) { status.textContent = error.message; }
    });
    reject.addEventListener('click', async () => {
      try { await api('/api/approval/reject', { method: 'POST', body: { approvalId } }); approvalBox.replaceChildren(); status.textContent = 'Rejected. No key was created.'; } catch (error) { status.textContent = error.message; }
    });
    return h('div', { class: 'row' }, [approve, reject]);
  };
  const revealPending = async () => {
    const latest = await api('/api/gateway/sites');
    const pending = latest.pendingReveals?.[0];
    if (!pending) { status.textContent = 'No new key is waiting. If you just approved, try again in a moment.'; return; }
    const revealed = await stepUpPost('/api/gateway/sites/reveal', { revealToken: pending.revealToken });
    showSecret(revealed.apiKey);
  };
  create.append(h('label', { for: 'key-name', class: 'sr-only', text: 'Key name' }), h('div', { class: 'row' }, [nameInput, createButton]), approvalBox, status);
  if (sites.pendingReveals?.length) {
    create.append(h('div', { class: 'row' }, [
      h('span', { text: 'A key you approved is waiting to be shown.' }),
      h('button', { type: 'button', class: 'btn', text: 'Show key once', onclick: () => revealPending().catch((error) => { status.textContent = error.message; }) }),
    ]));
  }

  const rows = sites.sites.map((site) => h('tr', {}, [
    h('td', { text: site.name }),
    h('td', {}, [h('code', { text: site.id.slice(0, 8) })]),
    h('td', { text: fmtDate(site.createdAt) }),
    h('td', { text: fmtDate(site.usage?.lastUsedAt) }),
    h('td', { text: String(site.usage?.requests ?? 0) }),
    h('td', {}, [site.revokedAt ? h('span', { class: 'badge bad', text: 'revoked' }) : h('span', { class: 'badge ok', text: 'active' })]),
    h('td', {}, [site.revokedAt ? null : h('button', {
      type: 'button', class: 'btn small danger', 'aria-label': 'Revoke key ' + site.name, text: 'Revoke',
      onclick: async () => {
        if (!await confirmAction('Revoke key?', `Sites using "${site.name}" will stop working immediately.`, 'Revoke')) return;
        try { await api('/api/panels/run', { method: 'POST', body: { operation: 'gateway:site_revoke', parameters: { id: site.id } } }); mountKeys(); } catch (error) { notice(error.message, 'error'); }
      },
    })]),
  ]));
  const list = h('div', { class: 'card' }, [
    h('h3', { text: 'Your keys' }),
    sites.sites.length ? h('div', { class: 'table-wrap' }, [h('table', {}, [
      h('caption', { class: 'sr-only', text: 'API keys' }),
      h('thead', {}, [h('tr', {}, ['Name', 'Prefix', 'Created', 'Last used', 'Requests', 'Status', ''].map((label) => h('th', { scope: 'col', text: label })))]),
      h('tbody', {}, rows),
    ])]) : h('p', { class: 'muted', text: 'No keys yet.' }),
    h('p', { class: 'muted small', text: 'The prefix is the key id; the full key is never stored or shown again.' }),
  ]);

  const usage = h('div', { class: 'card stack' }, [h('h3', { text: 'Use a key' })]);
  usage.append(h('p', { class: 'muted', text: state.config.gatewayUrl ? `Gateway base URL: ${state.config.gatewayUrl}` : 'The site gateway is not enabled. Set JARVIS_SITE_GATEWAY_PORT and restart JARVIS to turn it on; the URL below is a placeholder.' }));
  for (const [title, code] of snippets(state.config.gatewayUrl)) {
    usage.append(h('div', { class: 'snippet' }, [
      h('div', { class: 'row' }, [h('strong', { text: title }), h('button', { type: 'button', class: 'btn small', text: 'Copy', onclick: (event) => copyText(code, event.currentTarget) })]),
      h('pre', { class: 'modelfile', tabindex: '0' }, [h('code', { text: code })]),
    ]));
  }
  inner.append(secretBox, create, list, usage);
}

// ---------- learning view ----------
function stat(label, value) { return h('div', { class: 'stat' }, [h('span', { class: 'muted small', text: label }), h('b', { text: value })]); }
const pct = (value) => (value === null || value === undefined ? 'n/a' : Math.round(value * 100) + '%');

async function mountLearning() {
  const root = $('learning-view');
  const inner = h('div', { class: 'view-inner stack' });
  root.replaceChildren(inner);
  const section = (title, ...content) => { const card = h('div', { class: 'card stack' }, [h('h3', { text: title }), ...content]); inner.append(card); return card; };
  const failure = (card, error) => card.append(h('p', { class: 'muted', text: error.message }));

  // Memory candidates
  const candidatesCard = section('Memory candidates');
  try {
    const data = await api('/api/memory/manager');
    const learning = h('label', { class: 'inline-check' }, [h('input', { type: 'checkbox', ...(data.status.learningEnabled ? { checked: true } : {}) }), h('span', { text: 'Learning enabled (consent-based; nothing is learned without your approval)' })]);
    learning.querySelector('input').addEventListener('change', async (event) => {
      try { await api('/api/memory/learning', { method: 'POST', body: { enabled: event.currentTarget.checked } }); } catch (error) { notice(error.message, 'error'); }
    });
    candidatesCard.append(learning);
    if (!data.candidates.length) candidatesCard.append(h('p', { class: 'muted', text: 'No candidates waiting. Rate a reply Good or Bad in Chat to propose one.' }));
    for (const candidate of data.candidates) {
      const decide = async (decision) => {
        try { await api('/api/memory/candidates/decide', { method: 'POST', body: { id: candidate.id, decision } }); mountLearning(); } catch (error) { notice(error.message, 'error'); }
      };
      candidatesCard.append(h('div', { class: 'row' }, [
        h('span', { class: 'badge', text: candidate.category }),
        h('span', { text: candidate.content }),
        h('span', { class: 'topbar-spacer' }),
        h('button', { type: 'button', class: 'btn small primary', text: 'Approve', onclick: () => decide('approve') }),
        h('button', { type: 'button', class: 'btn small', text: 'Reject', onclick: () => decide('reject') }),
      ]));
    }
    const quality = data.status.quality;
    section('Learning quality',
      h('div', { class: 'stat-grid' }, [
        stat('Samples', String(quality.sampleCount)), stat('Helpful rate', pct(quality.helpfulRate)), stat('Precision@k', pct(quality.precisionAtK)),
        stat('Recall@k', pct(quality.recallAtK)), stat('Candidate acceptance', pct(quality.candidateAcceptanceRate)), stat('Trend', quality.trend.replace(/_/g, ' ')),
      ]),
    );
  } catch (error) { failure(candidatesCard, error); }

  // Development episodes from the JARVIS Learn VS Code extension (E3:D4.17)
  const episodesCard = section('From VS Code (JARVIS Learn)', h('p', { class: 'muted', text: 'Prompts, file changes, commands and results captured by the extension arrive here redacted and pending. Only episodes you approve become searchable knowledge.' }));
  try {
    const [{ episodes }, { keys }, { recipes }] = await Promise.all([
      api('/api/learning/episodes?status=pending'), api('/api/learning/ingest-keys'), api('/api/learning/recipes'),
    ]);
    episodesCard.append(h('div', { class: 'stat-grid' }, [stat('Pending episodes', String(episodes.length)), stat('Approved recipes', String(recipes.length)), stat('Active ingest keys', String(keys.filter((key) => !key.revokedAt).length))]));
    if (!episodes.length) episodesCard.append(h('p', { class: 'muted', text: 'Nothing waiting. Install the extension and set its ingest key to start capturing.' }));
    for (const stored of episodes.slice(0, 25)) {
      const ep = stored.episode;
      const commands = ep.steps.filter((step) => step.kind === 'command').map((step) => `${step.command}${step.exitCode === undefined ? '' : ` (exit ${step.exitCode})`}`);
      const files = [...new Set(ep.steps.map((step) => step.path).filter(Boolean))];
      const decide = async (decision) => {
        try { await api(`/api/learning/episodes/${decision}`, { method: 'POST', body: { id: stored.id } }); mountLearning(); } catch (error) { notice(error.message, 'error'); }
      };
      const details = h('details', {}, [
        h('summary', { text: `${ep.source} · ${fmtDate(Date.parse(stored.receivedAt))} · ${ep.steps.length} step(s)${ep.outcome ? ' · ' + ep.outcome.status : ''}` }),
        ...(ep.prompt ? [h('p', { text: 'Prompt: ' + ep.prompt })] : []),
        ...(files.length ? [h('p', { class: 'muted small', text: 'Files: ' + files.slice(0, 12).join(', ') })] : []),
        ...(commands.length ? [h('pre', {}, [h('code', { text: commands.slice(0, 12).join('\n') })])] : []),
        ...(ep.assistantGenerated ? [h('p', { class: 'muted small', text: 'Contains AI-assistant content: kept for search, excluded from training export by default.' })] : []),
      ]);
      episodesCard.append(h('div', { class: 'stack' }, [details, h('div', { class: 'row' }, [
        h('button', { type: 'button', class: 'btn small primary', text: 'Approve', onclick: () => decide('approve') }),
        h('button', { type: 'button', class: 'btn small', text: 'Reject', onclick: () => decide('reject') }),
      ])]));
    }
    // Ingest keys: scoped only to submitting episodes; shown once.
    const keyOut = h('div', { role: 'status', 'aria-live': 'polite' });
    const keyName = h('input', { type: 'text', id: 'ingest-key-name', placeholder: 'vscode-laptop', 'aria-label': 'Ingest key name' });
    const create = h('button', { type: 'button', class: 'btn', text: 'Create ingest key', onclick: async () => {
      try {
        const done = await api('/api/learning/ingest-keys/create', { method: 'POST', body: { name: keyName.value.trim() } });
        const value = h('code', { text: done.ingestKey });
        keyOut.replaceChildren(h('p', { text: 'Copy this key into VS Code ("JARVIS: Set ingest key"). It is shown once.' }), h('pre', {}, [value]),
          h('button', { type: 'button', class: 'btn small', text: 'Copy', onclick: () => navigator.clipboard?.writeText(done.ingestKey).then(() => notice('Copied.', 'ok')) }));
      } catch (error) { keyOut.replaceChildren(h('p', { class: 'muted', text: error.message })); }
    } });
    episodesCard.append(h('label', { for: 'ingest-key-name', text: 'New ingest key name (lowercase letters, digits, hyphens)' }), h('div', { class: 'row' }, [keyName, create]), keyOut);
    for (const key of keys.filter((k) => !k.revokedAt)) {
      episodesCard.append(h('div', { class: 'row' }, [
        h('strong', { text: key.name }), h('span', { class: 'muted small', text: `created ${fmtDate(Date.parse(key.createdAt))} · ${key.usage.accepted} accepted${key.usage.lastUsedAt ? ' · last used ' + fmtDate(Date.parse(key.usage.lastUsedAt)) : ''}` }),
        h('span', { class: 'topbar-spacer' }),
        h('button', { type: 'button', class: 'btn small', text: 'Revoke', onclick: async () => {
          if (!await confirmAction('Revoke ingest key?', `The extension using "${key.name}" stops sending episodes.`, 'Revoke')) return;
          try { await api('/api/learning/ingest-keys/revoke', { method: 'POST', body: { id: key.id } }); mountLearning(); } catch (error) { notice(error.message, 'error'); }
        } }),
      ]));
    }
  } catch (error) { failure(episodesCard, error); }

  // Knowledge sources
  const sourcesCard = section('Approved knowledge sources', h('p', { class: 'muted', text: 'JARVIS learns new knowledge only from sources you approve. It never learns from the internet automatically.' }));
  try {
    const data = await api('/api/knowledge/sources/list', { method: 'POST', body: {} });
    if (!data.sources.length) sourcesCard.append(h('p', { class: 'muted', text: 'No collections approved yet.' }));
    for (const source of data.sources) sourcesCard.append(h('div', { class: 'row' }, [h('strong', { text: source.collection }), h('span', { class: 'muted small', text: 'approved ' + fmtDate(source.approvedAt) })]));
  } catch (error) { sourcesCard.append(h('p', { class: 'muted', text: error.status === 503 ? 'Source enforcement is off (set JARVIS_KNOWLEDGE_SOURCES_ENFORCED=1 to require approved collections).' : error.message })); }

  // Persona and local model
  const personaCard = section('Persona and local model');
  try {
    const persona = await api('/api/studio/persona');
    const text = h('textarea', { id: 'persona-text', class: 'persona', maxlength: String(persona.maxChars), 'aria-label': 'System instructions' });
    text.value = persona.persona;
    const base = h('input', { type: 'text', id: 'base-model', value: persona.baseModel, placeholder: 'Base model, e.g. llama3.2:latest', 'aria-label': 'Base model' });
    const output = h('div', { class: 'stack', role: 'status', 'aria-live': 'polite' });
    const save = async () => {
      await api('/api/studio/persona', { method: 'PUT', body: { persona: text.value, baseModel: base.value.trim() } });
    };
    const preview = h('button', { type: 'button', class: 'btn', text: 'Preview Modelfile', onclick: async () => {
      try { await save(); const data = await api('/api/studio/modelfile'); output.replaceChildren(h('pre', { class: 'modelfile' }, [h('code', { text: data.modelfile })])); } catch (error) { output.replaceChildren(h('p', { class: 'muted', text: error.message })); }
    } });
    const build = h('button', { type: 'button', class: 'btn primary', text: 'Build local model', onclick: async () => {
      if (!await confirmAction('Build local model?', 'This runs "ollama create jarvis-personal" on this computer using your persona. It needs your approval next.', 'Request build')) return;
      try {
        await save();
        const result = await api('/api/studio/model/build', { method: 'POST', body: { confirm: true } });
        if (result.approvalId) {
          const approve = h('button', { type: 'button', class: 'btn primary', text: 'Approve and build' });
          approve.addEventListener('click', async () => {
            try { const done = await approveTask(result.approvalId, approve); output.replaceChildren(h('p', { text: done.message || ('Build state: ' + done.state) })); } catch (error) { output.replaceChildren(h('p', { class: 'muted', text: error.message })); }
          });
          output.replaceChildren(h('p', { text: 'Waiting for your approval.' }), approve);
        } else output.replaceChildren(h('p', { text: result.message || ('State: ' + result.state) }));
      } catch (error) { output.replaceChildren(h('p', { class: 'muted', text: error.message })); }
    } });
    personaCard.append(
      h('label', { for: 'persona-text', text: 'System instructions (saved locally, encrypted)' }), text,
      h('label', { for: 'base-model', text: 'Base model' }), base,
      h('div', { class: 'row' }, [h('button', { type: 'button', class: 'btn', text: 'Save persona', onclick: async () => { try { await save(); notice('Persona saved.', 'ok'); } catch (error) { notice(error.message, 'error'); } } }), preview, build]),
      output,
    );
  } catch (error) { failure(personaCard, error); }

  // Training data
  const trainingCard = section('Training data', h('p', { class: 'muted', text: 'Only conversations you mark "Use this chat for training" are exported, as chat-format JSONL to a local folder. Use the file for an optional offline LoRA fine-tune. Replies you rated Bad are left out.' }));
  try {
    const info = await api('/api/studio/training');
    const result = h('div', { role: 'status', 'aria-live': 'polite' });
    trainingCard.append(
      h('div', { class: 'stat-grid' }, [stat('Marked conversations', String(info.approvedConversations)), stat('Usable records', String(info.usableRecords))]),
      h('p', { class: 'muted small', text: 'Folder: ' + info.exportDirectory }),
      h('button', { type: 'button', class: 'btn primary', text: 'Export training data', onclick: async () => {
        if (!await confirmAction('Export training data?', `${info.usableRecords} conversation(s) will be written as plain text to ${info.exportDirectory}.`, 'Export')) return;
        try { const done = await api('/api/studio/training/export', { method: 'POST', body: { confirm: true } }); result.textContent = `Wrote ${done.records} record(s) to ${done.file}.`; } catch (error) { result.textContent = error.message; }
      } }),
      result,
    );
  } catch (error) { failure(trainingCard, error); }
}

// ---------- views ----------
const VIEW_TITLES = { chat: 'Chat', code: 'Code', keys: 'API keys', learning: 'Learning', models: 'Models' };
const registeredViews = new Map();
const mountedViews = new Set();

function registerView(name, mountFn) {
  if (typeof name !== 'string' || typeof mountFn !== 'function') throw new TypeError('registerView(name, mountFn) needs a name and a function');
  registeredViews.set(name, mountFn);
  if (name === 'code' && state.view === 'code') mountRegistered('code');
  if (name === 'models' && state.view === 'models') mountRegistered('models');
}

async function mountRegistered(name) {
  const container = $(name + '-view');
  const mountFn = registeredViews.get(name);
  if (!mountFn || mountedViews.has(name)) return;
  mountedViews.add(name);
  try { await mountFn(container, { api, notice, copyText, escapeHtml: (value) => String(value ?? '').replace(/[&<>"'`]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' }[c])) }); }
  catch (error) { mountedViews.delete(name); container.replaceChildren(h('div', { class: 'notice error', text: 'The ' + name + ' view failed to load: ' + error.message })); }
}

/** Load /studio/code/code.js once, if it exists; it should call JarvisStudio.registerView('code', mountFn). */
function loadCodeScript() {
  if (registeredViews.has('code')) return mountRegistered('code');
  const container = $('code-view');
  if (container.dataset.loading) return undefined;
  container.dataset.loading = '1';
  container.replaceChildren(h('p', { class: 'muted', text: 'Loading Code view...' }));
  const script = document.createElement('script');
  script.src = '/studio/code/code.js';
  script.onload = () => { if (!registeredViews.has('code')) container.replaceChildren(h('div', { class: 'notice', text: 'The Code view script loaded but did not register itself.' })); };
  script.onerror = () => { delete container.dataset.loading; container.replaceChildren(h('div', { class: 'notice' }, ['The Code view is not installed yet. It is provided separately at ', h('code', { text: '/studio/code/code.js' }), '.'])); };
  document.head.append(script);
  return undefined;
}

/** Load /studio/models.js once; it calls JarvisStudio.registerView('models', mountFn). */
function loadModelsScript() {
  if (registeredViews.has('models')) return mountRegistered('models');
  const container = $('models-view');
  if (container.dataset.loading) return undefined;
  container.dataset.loading = '1';
  const script = document.createElement('script');
  script.src = '/studio/models.js';
  script.onerror = () => { delete container.dataset.loading; container.replaceChildren(h('div', { class: 'notice' }, 'The Models view could not be loaded.')); };
  document.head.append(script);
  return undefined;
}

function setView(name) {
  state.view = name;
  for (const view of ['chat', 'code', 'keys', 'learning', 'models']) $(view + '-view').hidden = view !== name;
  document.querySelectorAll('.nav-item').forEach((button) => {
    if (button.dataset.view === name) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
  });
  $('view-title').textContent = name === 'chat' ? (state.current?.title || 'Chat') : VIEW_TITLES[name];
  $('train-toggle-wrap').hidden = name !== 'chat' || !state.current;
  notice('');
  if (name === 'keys') mountKeys();
  else if (name === 'learning') mountLearning();
  else if (name === 'code') loadCodeScript();
  else if (name === 'models') loadModelsScript();
  closeSidebar();
}

function openSidebar() { $('sidebar').classList.add('open'); $('scrim').hidden = false; }
function closeSidebar() { $('sidebar').classList.remove('open'); $('scrim').hidden = true; }

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  $('theme-toggle').setAttribute('aria-pressed', String(theme === 'dark'));
  $('theme-toggle').textContent = theme === 'dark' ? 'Light theme' : 'Dark theme';
}

// ---------- sign-in gate ----------
async function signIn() {
  const message = $('gate-message');
  if (!window.JarvisDeviceCrypto) { message.textContent = 'The secure device module could not load.'; return; }
  message.textContent = 'Checking for your owner session...';
  try {
    const session = await window.JarvisDeviceCrypto.restoreSession();
    if (!session.permissions?.includes(OWNER_PERMISSION)) {
      message.textContent = 'This device is signed in but is not an owner device. JARVIS Studio is owner-only.';
      return;
    }
    $('gate').hidden = true;
    $('app').hidden = false;
    $('device-label').textContent = session.deviceName || '';
    await start();
  } catch (error) {
    message.textContent = (error?.message || 'Sign-in failed') + '. Enroll this browser from the JARVIS companion first, then come back.';
  }
}

async function start() {
  applyTheme(prefs.get('studio.theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
  await Promise.all([loadModels(), loadConversations().catch((error) => notice(error.message, 'error'))]);
  try { state.config = await api('/api/studio/config'); } catch { /* optional */ }
  setView('chat');
  renderThread();
}

function bind() {
  $('gate-retry').addEventListener('click', signIn);
  $('new-chat').addEventListener('click', newChat);
  $('sidebar-open').addEventListener('click', openSidebar);
  $('sidebar-close').addEventListener('click', closeSidebar);
  $('scrim').addEventListener('click', closeSidebar);
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeSidebar(); });
  document.querySelectorAll('.nav-item').forEach((button) => button.addEventListener('click', () => setView(button.dataset.view)));
  $('theme-toggle').addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    prefs.set('studio.theme', next);
  });
  let searchTimer = 0;
  $('chat-search').addEventListener('input', (event) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { state.search = event.target.value.trim(); loadConversations().catch((error) => notice(error.message, 'error')); }, 250);
  });
  $('model-select').addEventListener('change', (event) => prefs.set('studio.model', event.target.value));
  $('train-toggle').addEventListener('change', async (event) => {
    if (!state.current) return;
    try { await api('/api/studio/conversations/' + state.current.id, { method: 'PATCH', body: { useForTraining: event.target.checked } }); state.current.useForTraining = event.target.checked; }
    catch (error) { event.target.checked = !event.target.checked; notice(error.message, 'error'); }
  });
  const prompt = $('prompt');
  prompt.addEventListener('input', autosize);
  prompt.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); $('composer').requestSubmit(); }
  });
  $('composer').addEventListener('submit', (event) => {
    event.preventDefault();
    const text = prompt.value.trim();
    if (!text || state.streaming) return;
    prompt.value = '';
    autosize();
    sendMessage(text).catch((error) => notice(error.message, 'error'));
  });
  $('stop').addEventListener('click', stopStreaming);
  $('attach').addEventListener('click', () => $('file-input').click());
  $('file-input').addEventListener('change', async (event) => { const [file] = event.target.files; event.target.value = ''; await attachFile(file); });
  $('totp-cancel').addEventListener('click', () => $('totp-dialog').close('cancel'));
  $('totp-form').addEventListener('submit', (event) => {
    event.preventDefault();
    if (!isValidTotpCode($('totp-input').value)) { $('totp-error').textContent = 'Enter the 6-digit code from your authenticator app.'; $('totp-error').hidden = false; return; }
    $('totp-dialog').close('ok');
  });
  $('text-dialog-cancel').addEventListener('click', () => $('text-dialog').close('cancel'));
  $('text-dialog-form').addEventListener('submit', (event) => { event.preventDefault(); $('text-dialog').close('ok'); });
}

window.JarvisStudio = Object.freeze({ registerView, api: (path, options) => api(path, options), stepUpPost: (path, body) => stepUpPost(path, body), version: 1 });
bind();
signIn();
