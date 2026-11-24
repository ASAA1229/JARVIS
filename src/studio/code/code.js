/* JARVIS Studio - Code view.
 * A lightweight in-house code editor and coding helper for owner-approved folders.
 * No runtime dependencies, no CDN. Registers itself with the Studio shell:
 *   window.JarvisStudio.registerView('code', mountFn)
 * Every file change goes through a diff review and the JARVIS approval flow; nothing is written
 * by the helper or by this UI without an explicit approval.
 */
(function () {
  'use strict';

  // ---------- small DOM helpers ----------
  function el(tag, props, children) {
    var node = document.createElement(tag);
    if (props) {
      Object.keys(props).forEach(function (key) {
        var value = props[key];
        if (value === undefined || value === null || value === false) return;
        if (key === 'class') node.className = value;
        else if (key === 'text') node.textContent = value;
        else if (key.slice(0, 2) === 'on' && typeof value === 'function') node.addEventListener(key.slice(2), value);
        else node.setAttribute(key, value === true ? '' : String(value));
      });
    }
    (children || []).forEach(function (child) {
      if (child === null || child === undefined || child === false) return;
      node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    });
    return node;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
  function escapeHtml(text) {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function baseName(path) { var i = path.lastIndexOf('/'); return i < 0 ? path : path.slice(i + 1); }
  function parentOf(path) { var i = path.lastIndexOf('/'); return i < 0 ? '' : path.slice(0, i); }

  // ---------- syntax highlighting (small tokenizer per language) ----------
  var JS_KW = new Set(('break case catch class const continue debugger default delete do else enum export extends false finally for from function if implements import in instanceof interface let new null of private protected public readonly return static super switch this throw true try type typeof undefined var void while with yield async await as declare namespace abstract satisfies keyof').split(' '));
  var PY_KW = new Set(('False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield self').split(' '));
  var LANG_RULES = {
    js: [
      ['com', /\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$)/y],
      ['str', /"(?:\\.|[^"\\\n])*"?|'(?:\\.|[^'\\\n])*'?|`(?:\\[\s\S]|[^`\\])*`?/y],
      ['num', /\b(?:0x[\da-f]+|\d+(?:\.\d+)?(?:e[+-]?\d+)?)n?\b/iy],
      ['word', /[A-Za-z_$][\w$]*/y]
    ],
    json: [
      ['key', /"(?:\\.|[^"\\\n])*"(?=\s*:)/y],
      ['str', /"(?:\\.|[^"\\\n])*"?/y],
      ['num', /-?\b\d+(?:\.\d+)?(?:e[+-]?\d+)?\b/iy],
      ['kw', /\b(?:true|false|null)\b/y]
    ],
    py: [
      ['com', /#[^\n]*/y],
      ['str', /(?:"""[\s\S]*?(?:"""|$)|'''[\s\S]*?(?:'''|$)|"(?:\\.|[^"\\\n])*"?|'(?:\\.|[^'\\\n])*'?)/y],
      ['num', /\b\d+(?:\.\d+)?\b/y],
      ['fn', /@[\w.]+/y],
      ['word', /[A-Za-z_][\w]*/y]
    ],
    css: [
      ['com', /\/\*[\s\S]*?(?:\*\/|$)/y],
      ['str', /"(?:\\.|[^"\\\n])*"?|'(?:\\.|[^'\\\n])*'?/y],
      ['kw', /@[\w-]+/y],
      ['num', /#[\da-f]{3,8}\b|-?\d*\.?\d+(?:px|em|rem|%|vh|vw|s|ms|deg|fr)?\b/iy],
      ['key', /[\w-]+(?=\s*:(?!:))/y],
      ['fn', /[.#][\w-]+/y]
    ],
    html: [
      ['com', /<!--[\s\S]*?(?:-->|$)/y],
      ['kw', /<\/?[A-Za-z][\w:-]*|\/?>/y],
      ['str', /"[^"]*"?|'[^']*'?/y],
      ['key', /[\w:-]+(?=\s*=)/y]
    ],
    md: [
      ['str', /```[\s\S]*?(?:```|$)/y],
      ['hd', /^#{1,6}[ \t][^\n]*/my],
      ['str', /`[^`\n]+`/y],
      ['kw', /\*\*[^*\n]+\*\*|__[^_\n]+__/y],
      ['fn', /\[[^\]\n]*\]\([^)\n]*\)/y],
      ['num', /^[ \t]*(?:[-*+]|\d+\.)[ \t]/my]
    ]
  };
  LANG_RULES.ts = LANG_RULES.js;

  function highlight(text, lang) {
    var rules = LANG_RULES[lang];
    if (!rules || text.length > 300000) return escapeHtml(text);
    var out = '';
    var plain = '';
    var pos = 0;
    var length = text.length;
    var keywords = lang === 'py' ? PY_KW : JS_KW;
    function flush() { if (plain) { out += escapeHtml(plain); plain = ''; } }
    while (pos < length) {
      var matched = false;
      for (var r = 0; r < rules.length; r++) {
        var rule = rules[r];
        rule[1].lastIndex = pos;
        var m = rule[1].exec(text);
        if (m && m[0].length) {
          var cls = rule[0];
          var token = m[0];
          if (cls === 'word') {
            if (keywords.has(token)) cls = 'kw';
            else if (/^[A-Z]/.test(token) && lang !== 'py') cls = 'tp';
            else if (text.charAt(pos + token.length) === '(') cls = 'fn';
            else cls = '';
          }
          if (cls) { flush(); out += '<span class="t-' + cls + '">' + escapeHtml(token) + '</span>'; }
          else plain += token;
          pos += token.length;
          matched = true;
          break;
        }
      }
      if (!matched) { plain += text.charAt(pos); pos++; }
    }
    flush();
    return out;
  }

  // ---------- diff rendering ----------
  function renderDiff(diff) {
    var box = el('div', { class: 'jvc-diff', role: 'region', 'aria-label': 'Proposed changes (unified diff)', tabindex: '0' });
    if (!diff) { box.appendChild(el('div', { class: 'jvc-empty', text: 'No changes.' })); return box; }
    diff.replace(/\n$/, '').split('\n').forEach(function (line) {
      var kind = 'ctx';
      var marker = ' ';
      var body = line;
      if (line.indexOf('+++ ') === 0 || line.indexOf('--- ') === 0) { kind = 'file'; marker = ''; }
      else if (line.indexOf('@@') === 0) { kind = 'hunk'; marker = ''; }
      else if (line.charAt(0) === '+') { kind = 'add'; marker = '+'; body = line.slice(1); }
      else if (line.charAt(0) === '-') { kind = 'del'; marker = '-'; body = line.slice(1); }
      else if (line.charAt(0) === ' ') { body = line.slice(1); }
      else if (line.charAt(0) === '\\') { kind = 'hunk'; marker = ''; }
      var row = el('div', { class: 'jvc-dl ' + kind }, [
        marker ? el('span', { class: 'm', 'aria-hidden': 'true', text: marker }) : null,
        kind === 'add' ? el('span', { class: 'jvc-sr', text: 'Added: ' }) : null,
        kind === 'del' ? el('span', { class: 'jvc-sr', text: 'Removed: ' }) : null,
        el('span', { text: body })
      ]);
      box.appendChild(row);
    });
    return box;
  }

  // ---------- the view ----------
  function mount(container) {
    clear(container);
    var root = el('div', { class: 'jvc', role: 'region', 'aria-label': 'Code editor and coding helper' });
    container.appendChild(root);

    var state = {
      roots: [], scripts: [], model: null, root: null,
      tabs: [], active: -1, selectedNode: null, selectedPath: '', selectedType: 'dir',
      treeBusy: new Set(), helperHistory: [], streaming: null, findIndex: -1
    };

    // ----- signed API -----
    function api(path, method, body) {
      var crypto = window.JarvisDeviceCrypto;
      if (!crypto || typeof crypto.signedFetch !== 'function') return Promise.reject(new Error('Secure session is not available in this browser. Open JARVIS and sign in as the owner first.'));
      var options = body === undefined ? { method: method || 'GET' } : { method: method || 'POST', body: body };
      return crypto.signedFetch(path, options).then(function (response) {
        return response.json().catch(function () { return {}; }).then(function (payload) {
          if (!response.ok) { var error = new Error(payload.error || ('Request failed (HTTP ' + response.status + ')')); error.status = response.status; error.payload = payload; throw error; }
          return payload;
        });
      });
    }

    // ----- status line -----
    var statusMsg = el('span', { role: 'status', 'aria-live': 'polite' });
    var statusPos = el('span', { 'aria-hidden': 'true' });
    var statusLang = el('span', { 'aria-hidden': 'true' });
    function status(text, kind) { statusMsg.textContent = text || ''; if (kind) statusMsg.setAttribute('data-kind', kind); else statusMsg.removeAttribute('data-kind'); }

    // ----- modal dialog -----
    function modal(title, nodes, buttons) {
      return new Promise(function (resolve) {
        var previous = document.activeElement;
        var heading = el('h2', { id: 'jvc-dlg-' + Math.random().toString(36).slice(2), text: title });
        var actions = el('div', { class: 'jvc-row-actions' });
        var dialog = el('div', { class: 'jvc-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': heading.id }, [heading].concat(nodes, [actions]));
        var overlay = el('div', { class: 'jvc-overlay' }, [dialog]);
        function close(value) {
          document.removeEventListener('keydown', onKey, true);
          overlay.remove();
          if (previous && previous.focus) previous.focus();
          resolve(value);
        }
        buttons.forEach(function (spec) {
          var button = el('button', { type: 'button', class: 'jvc-btn' + (spec.primary ? ' primary' : '') + (spec.danger ? ' danger' : ''), text: spec.label });
          button.addEventListener('click', function () {
            if (spec.onClick) {
              var outcome = spec.onClick(button, close);
              if (outcome === false) return;
            } else close(spec.value);
          });
          actions.appendChild(button);
        });
        function onKey(event) {
          if (event.key === 'Escape') { event.stopPropagation(); close(null); }
          else if (event.key === 'Tab') {
            var focusable = dialog.querySelectorAll('button, input, select, textarea, [tabindex="0"]');
            if (!focusable.length) return;
            var first = focusable[0]; var last = focusable[focusable.length - 1];
            if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
            else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
          }
        }
        document.addEventListener('keydown', onKey, true);
        root.appendChild(overlay);
        var firstInput = dialog.querySelector('input, textarea, select') || actions.querySelector('.primary') || actions.querySelector('button');
        if (firstInput) firstInput.focus();
      });
    }

    // Shows a task result honestly. When it needs approval, asks right here (the same
    // /api/approval/approve flow the HUD uses). Resolves to the final task result or null if rejected.
    function awaitApproval(result, title, diff, note) {
      if (!result || result.state !== 'AWAITING_APPROVAL' || !result.approvalId) return Promise.resolve(result);
      var nodes = [el('p', { text: note || 'JARVIS needs your approval before anything changes. Review what will happen, then approve or reject.' })];
      if (diff) nodes.push(renderDiff(diff));
      var busy = el('p', { role: 'status', 'aria-live': 'polite' });
      nodes.push(busy);
      return modal(title, nodes, [
        { label: 'Reject', value: 'reject', onClick: function (button, close) {
          api('/api/approval/reject', 'POST', { approvalId: result.approvalId }).catch(function () {}).then(function () { close('reject'); });
        } },
        { label: 'Approve', primary: true, onClick: function (button, close) {
          button.disabled = true; busy.textContent = 'Approving...';
          approvePost(result.approvalId).then(function (final) { close({ final: final }); },
            function (error) { busy.textContent = 'Approval failed: ' + error.message; button.disabled = false; });
        } }
      ]).then(function (outcome) {
        if (outcome && outcome.final) return outcome.final;
        if (outcome === 'reject') { status('Rejected. Nothing was changed.', 'warn'); return null; }
        // Dialog dismissed: the approval stays pending in the HUD; nothing has run.
        status('Approval is still pending in the HUD; nothing has changed.', 'warn');
        return null;
      });
    }
    // Approvals use the shell's authenticator step-up when available: with TOTP enabled the server requires a fresh code.
    function approvePost(approvalId) {
      var shell = window.JarvisStudio;
      if (shell && typeof shell.stepUpPost === 'function') return shell.stepUpPost('/api/approval/approve', { approvalId: approvalId });
      return api('/api/approval/approve', 'POST', { approvalId: approvalId });
    }
    function succeeded(result) { return Boolean(result) && result.state === 'COMPLETED'; }
    function describe(result) { return result ? String(result.message || result.state || 'No result') : 'Cancelled'; }

    // ----- top bar: roots and model -----
    var rootSelect = el('select', { class: 'jvc-select', id: 'jvc-root', 'aria-label': 'Workspace folder', onchange: function () { switchRoot(rootSelect.value); } });
    var modelNote = el('span', { class: 'jvc-model', 'data-ok': 'false', text: 'Local model: checking' });
    var addRootBtn = el('button', { type: 'button', class: 'jvc-btn', text: 'Add folder', onclick: addRootDialog });
    var removeRootBtn = el('button', { type: 'button', class: 'jvc-btn danger', text: 'Remove', onclick: removeRoot });
    var top = el('div', { class: 'jvc-top' }, [
      el('label', { for: 'jvc-root', text: 'Folder' }), rootSelect, addRootBtn, removeRootBtn,
      el('span', { class: 'jvc-spacer' }), modelNote
    ]);

    // ----- sidebar: tools, search, tree -----
    var treeEl = el('ul', { class: 'jvc-tree', role: 'tree', 'aria-label': 'Files' });
    var resultsEl = el('div', { class: 'jvc-results', hidden: true, role: 'region', 'aria-label': 'Search results' });
    var searchInput = el('input', { class: 'jvc-input', type: 'search', placeholder: 'Search files and text', 'aria-label': 'Search files and text',
      onkeydown: function (event) { if (event.key === 'Enter') runSearch(); else if (event.key === 'Escape') { searchInput.value = ''; resultsEl.hidden = true; treeEl.hidden = false; } } });
    var side = el('div', { class: 'jvc-side' }, [
      el('h2', { class: 'jvc-h', text: 'Files' }),
      el('div', { class: 'jvc-tools' }, [
        el('button', { type: 'button', class: 'jvc-btn', text: 'New file', onclick: newFile }),
        el('button', { type: 'button', class: 'jvc-btn', text: 'Rename', onclick: renameSelected }),
        el('button', { type: 'button', class: 'jvc-btn danger', text: 'Delete', onclick: deleteSelected }),
        el('button', { type: 'button', class: 'jvc-btn', text: 'Refresh', onclick: function () { loadTree(); } })
      ]),
      el('div', { class: 'jvc-search' }, [searchInput, el('button', { type: 'button', class: 'jvc-btn', text: 'Go', onclick: runSearch })]),
      treeEl, resultsEl
    ]);

    // ----- center: tabs, find bar, editor -----
    var tabsEl = el('div', { class: 'jvc-tabs', role: 'tablist', 'aria-label': 'Open files' });
    var findInput = el('input', { class: 'jvc-input', type: 'search', placeholder: 'Find', 'aria-label': 'Find in file',
      oninput: function () { state.findIndex = -1; findNext(1, true); },
      onkeydown: function (event) { if (event.key === 'Enter') { event.preventDefault(); findNext(event.shiftKey ? -1 : 1); } else if (event.key === 'Escape') closeFind(); } });
    var findCount = el('span', { class: 'jvc-findcount', 'aria-live': 'polite' });
    var findBar = el('div', { class: 'jvc-findbar', hidden: true, role: 'search' }, [
      findInput,
      el('button', { type: 'button', class: 'jvc-btn', text: 'Prev', 'aria-label': 'Previous match', onclick: function () { findNext(-1); } }),
      el('button', { type: 'button', class: 'jvc-btn', text: 'Next', 'aria-label': 'Next match', onclick: function () { findNext(1); } }),
      findCount,
      el('button', { type: 'button', class: 'jvc-btn', text: 'Close', onclick: closeFind })
    ]);
    var gutter = el('pre', { class: 'jvc-gutter', 'aria-hidden': 'true' });
    var hl = el('pre', { class: 'jvc-hl', 'aria-hidden': 'true' });
    var ta = el('textarea', { class: 'jvc-ta', spellcheck: 'false', autocapitalize: 'off', autocomplete: 'off', wrap: 'off', 'aria-label': 'Code editor. Press Escape then Tab to leave the editor.' });
    var editorWrap = el('div', { class: 'jvc-ed', hidden: true }, [gutter, el('div', { class: 'jvc-stack' }, [hl, ta])]);
    var placeholder = el('div', { class: 'jvc-placeholder', text: 'Add a folder, then open a file from the tree. Saving shows a diff and asks for your approval.' });
    var center = el('div', { class: 'jvc-center' }, [tabsEl, findBar, editorWrap, placeholder]);

    // ----- helper panel -----
    var ctxLine = el('div', { class: 'jvc-ctx', 'aria-live': 'polite' });
    var chat = el('div', { class: 'jvc-chat', role: 'log', 'aria-label': 'Coding helper conversation', 'aria-live': 'polite', tabindex: '0' });
    var promptInput = el('textarea', { 'aria-label': 'Message for the coding helper', placeholder: 'Ask about this file, or describe the change you want', onkeydown: function (event) {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); askHelper('chat'); }
    } });
    var stopBtn = el('button', { type: 'button', class: 'jvc-btn', text: 'Stop', hidden: true, onclick: function () { if (state.streaming) state.streaming.abort(); } });
    var sendBtn = el('button', { type: 'button', class: 'jvc-btn primary', text: 'Send', onclick: function () { askHelper('chat'); } });
    var chips = el('div', { class: 'jvc-chips', role: 'group', 'aria-label': 'Helper actions' }, [
      ['explain', 'Explain'], ['fix', 'Fix'], ['refactor', 'Refactor'], ['tests', 'Write tests'], ['generate', 'Generate file']
    ].map(function (pair) { return el('button', { type: 'button', class: 'jvc-btn', text: pair[1], onclick: function () { askHelper(pair[0]); } }); }));
    var scriptSelect = el('select', { class: 'jvc-select', 'aria-label': 'Project script to run' });
    var runBtn = el('button', { type: 'button', class: 'jvc-btn', text: 'Run (needs approval)', onclick: runScript });
    var runOut = el('pre', { hidden: true, tabindex: '0', 'aria-label': 'Script output' });
    var runBox = el('div', { class: 'jvc-run' }, [
      el('div', { class: 'jvc-row-actions' }, [scriptSelect, runBtn]),
      el('small', { class: 'jvc-model', text: 'Only the allowlisted project scripts run, in a connected git repository.' }),
      runOut
    ]);
    var helper = el('div', { class: 'jvc-helper' }, [
      el('h2', { class: 'jvc-h', text: 'Coding helper' }), ctxLine, chips, chat,
      el('div', { class: 'jvc-compose' }, [promptInput, el('div', { class: 'jvc-row-actions' }, [sendBtn, stopBtn])]),
      runBox
    ]);

    root.appendChild(top);
    root.appendChild(el('div', { class: 'jvc-main' }, [side, center, helper]));
    root.appendChild(el('div', { class: 'jvc-status' }, [statusMsg, el('span', { class: 'jvc-spacer' }), statusPos, statusLang]));

    // ====== tabs and editor ======
    function activeTab() { return state.tabs[state.active] || null; }
    function isDirty(tab) { return tab.text !== tab.saved; }

    function renderTabs() {
      clear(tabsEl);
      state.tabs.forEach(function (tab, index) {
        var dirty = isDirty(tab);
        var label = baseName(tab.path);
        var tabButton = el('button', { type: 'button', role: 'tab', 'aria-selected': index === state.active ? 'true' : 'false',
          tabindex: index === state.active ? '0' : '-1', title: tab.path, style: 'border:0;background:transparent;color:inherit;padding:6px 4px 6px 6px;cursor:pointer',
          onclick: function () { activate(index); },
          onkeydown: function (event) {
            if (event.key === 'ArrowRight' && state.tabs.length) { activate((index + 1) % state.tabs.length); tabsEl.querySelector('[aria-selected="true"]').focus(); }
            else if (event.key === 'ArrowLeft' && state.tabs.length) { activate((index - 1 + state.tabs.length) % state.tabs.length); tabsEl.querySelector('[aria-selected="true"]').focus(); }
          } }, [label, dirty ? el('span', { class: 'dirty', 'aria-label': ' (unsaved changes)', text: ' \u25CF' }) : null]);
        var wrapper = el('div', { class: 'jvc-tab', role: 'presentation', 'data-active': index === state.active ? 'true' : 'false' }, [
          tabButton,
          el('button', { type: 'button', class: 'x', 'aria-label': 'Close ' + label, text: '\u00D7', onclick: function (event) { event.stopPropagation(); closeTab(index); } })
        ]);
        tabsEl.appendChild(wrapper);
      });
    }

    function activate(index) {
      saveViewState();
      state.active = index;
      var tab = activeTab();
      renderTabs();
      if (!tab) { editorWrap.hidden = true; placeholder.hidden = false; updateContext(); statusLang.textContent = ''; statusPos.textContent = ''; return; }
      placeholder.hidden = true; editorWrap.hidden = false;
      ta.value = tab.text;
      ta.setAttribute('data-plain', LANG_RULES[tab.language] && tab.text.length <= 300000 ? 'false' : 'true');
      refreshHighlight();
      ta.scrollTop = tab.scrollTop || 0; ta.scrollLeft = tab.scrollLeft || 0;
      syncScroll();
      if (typeof tab.selStart === 'number') { try { ta.setSelectionRange(tab.selStart, tab.selEnd); } catch (e) { /* ignore */ } }
      statusLang.textContent = tab.language;
      updateCaret();
      updateContext();
      if (!findBar.hidden) findNext(1, true);
    }
    function saveViewState() {
      var tab = activeTab();
      if (!tab) return;
      tab.text = ta.value; tab.scrollTop = ta.scrollTop; tab.scrollLeft = ta.scrollLeft; tab.selStart = ta.selectionStart; tab.selEnd = ta.selectionEnd;
    }
    function closeTab(index) {
      saveViewState();
      var tab = state.tabs[index];
      var proceed = !isDirty(tab) ? Promise.resolve(true) : modal('Discard unsaved changes?', [el('p', { text: baseName(tab.path) + ' has changes that were not saved.' })], [
        { label: 'Keep editing', value: false }, { label: 'Discard changes', danger: true, value: true }
      ]);
      proceed.then(function (ok) {
        if (!ok) return;
        state.tabs.splice(index, 1);
        var next = state.tabs.length ? Math.min(index, state.tabs.length - 1) : -1;
        state.active = -2;
        activate(next);
      });
    }

    function refreshHighlight() {
      var tab = activeTab();
      var text = ta.value;
      var lines = text.split('\n').length;
      hl.innerHTML = highlight(text, tab ? tab.language : 'text') + '\n';
      var numbers = '';
      for (var i = 1; i <= lines; i++) numbers += i + '\n';
      gutter.textContent = numbers;
    }
    var rafPending = false;
    function scheduleHighlight() {
      if (rafPending) return;
      rafPending = true;
      requestAnimationFrame(function () { rafPending = false; refreshHighlight(); syncScroll(); });
    }
    function syncScroll() { hl.scrollTop = ta.scrollTop; hl.scrollLeft = ta.scrollLeft; gutter.scrollTop = ta.scrollTop; }
    function updateCaret() {
      var upto = ta.value.slice(0, ta.selectionStart);
      var line = upto.split('\n').length;
      var col = ta.selectionStart - upto.lastIndexOf('\n');
      statusPos.textContent = 'Ln ' + line + ', Col ' + col;
    }
    function selectionInfo() {
      var start = ta.selectionStart; var end = ta.selectionEnd;
      if (start === end) return null;
      var text = ta.value;
      return { text: text.slice(start, end), startLine: text.slice(0, start).split('\n').length, endLine: text.slice(0, end).split('\n').length };
    }
    function updateContext() {
      var tab = activeTab();
      if (!tab) { ctxLine.textContent = 'No file open. The helper can still generate a new file.'; return; }
      var info = editorWrap.hidden ? null : selectionInfo();
      ctxLine.textContent = 'File: ' + tab.path + (info ? ' | selection: lines ' + info.startLine + '-' + info.endLine : '') + (isDirty(tab) ? ' | unsaved edits are included' : '');
    }

    ta.addEventListener('input', function () {
      var tab = activeTab();
      if (tab) { tab.text = ta.value; }
      scheduleHighlight(); renderTabs(); updateCaret(); updateContext();
    });
    ta.addEventListener('scroll', syncScroll);
    ['keyup', 'click', 'select'].forEach(function (name) { ta.addEventListener(name, function () { updateCaret(); updateContext(); }); });
    var tabTrap = true;
    ta.addEventListener('keydown', function (event) {
      var mod = event.ctrlKey || event.metaKey;
      if (mod && event.key.toLowerCase() === 's') { event.preventDefault(); saveActive(); return; }
      if (mod && event.key.toLowerCase() === 'f') { event.preventDefault(); openFind(); return; }
      if (event.key === 'Escape') { tabTrap = false; return; }
      if (event.key === 'Tab' && tabTrap && !mod) {
        event.preventDefault();
        insertText('  ');
        return;
      }
      tabTrap = true;
      if (event.key === 'Enter' && !mod && !event.shiftKey) {
        var before = ta.value.slice(0, ta.selectionStart);
        var lineStart = before.lastIndexOf('\n') + 1;
        var indent = /^[ \t]*/.exec(before.slice(lineStart))[0];
        var extra = /[{(\[]\s*$/.test(before.slice(lineStart)) ? '  ' : '';
        event.preventDefault();
        insertText('\n' + indent + extra);
      }
    });
    function insertText(text) {
      ta.focus();
      var done = false;
      try { done = document.execCommand('insertText', false, text); } catch (e) { done = false; }
      if (!done) { ta.setRangeText(text, ta.selectionStart, ta.selectionEnd, 'end'); ta.dispatchEvent(new Event('input', { bubbles: true })); }
    }
    root.addEventListener('keydown', function (event) {
      var mod = event.ctrlKey || event.metaKey;
      if (mod && event.key.toLowerCase() === 's' && event.target !== ta) { event.preventDefault(); saveActive(); }
      else if (mod && event.key.toLowerCase() === 'f' && event.target !== ta && activeTab()) { event.preventDefault(); openFind(); }
    });

    // ----- find -----
    function openFind() {
      if (!activeTab()) return;
      findBar.hidden = false;
      var info = selectionInfo();
      if (info && info.text.indexOf('\n') < 0) findInput.value = info.text;
      findInput.focus(); findInput.select();
      state.findIndex = -1; findNext(1, true);
    }
    function closeFind() { findBar.hidden = true; findCount.textContent = ''; ta.focus(); }
    function findNext(direction, keepPosition) {
      var needle = findInput.value;
      if (!needle) { findCount.textContent = ''; return; }
      var hay = ta.value.toLowerCase();
      var lower = needle.toLowerCase();
      var all = []; var at = hay.indexOf(lower);
      while (at >= 0 && all.length < 10000) { all.push(at); at = hay.indexOf(lower, at + Math.max(lower.length, 1)); }
      if (!all.length) { findCount.textContent = 'No matches'; return; }
      var from = keepPosition ? ta.selectionStart : (direction > 0 ? ta.selectionEnd : ta.selectionStart - 1);
      var target = -1;
      if (direction > 0) { for (var i = 0; i < all.length; i++) if (all[i] >= from) { target = i; break; } if (target < 0) target = 0; }
      else { for (var j = all.length - 1; j >= 0; j--) if (all[j] < from) { target = j; break; } if (target < 0) target = all.length - 1; }
      var start = all[target];
      ta.setSelectionRange(start, start + needle.length);
      var line = ta.value.slice(0, start).split('\n').length - 1;
      var top = line * 20;
      if (top < ta.scrollTop || top > ta.scrollTop + ta.clientHeight - 40) ta.scrollTop = Math.max(0, top - ta.clientHeight / 2);
      syncScroll(); updateCaret();
      findCount.textContent = (target + 1) + ' of ' + all.length + (all.length >= 10000 ? '+' : '');
    }

    // ====== roots ======
    function loadRoots(keep, prefer) {
      return api('/api/workspace/roots').then(function (data) {
        state.roots = data.roots || []; state.scripts = data.scripts || []; state.model = data.model || null;
        clear(rootSelect);
        if (!state.roots.length) rootSelect.appendChild(el('option', { value: '', text: 'No folders yet' }));
        state.roots.forEach(function (item) { rootSelect.appendChild(el('option', { value: item.name, text: item.name + ' (' + item.path + ')' })); });
        var names = state.roots.map(function (item) { return item.name; });
        var wanted = prefer && names.indexOf(prefer) >= 0 ? prefer : keep && names.indexOf(state.root) >= 0 ? state.root : names[0];
        rootSelect.value = wanted || '';
        removeRootBtn.disabled = !wanted;
        clear(scriptSelect);
        state.scripts.forEach(function (name) { scriptSelect.appendChild(el('option', { value: name, text: 'npm run ' + name })); });
        var m = state.model;
        modelNote.setAttribute('data-ok', m && m.available ? 'true' : 'false');
        modelNote.textContent = m && m.configured ? 'Local model: ' + (m.name || 'ollama') + (m.available ? '' : ' (unavailable)') : 'Local model: not configured';
        if (wanted !== state.root || !keep || prefer) return switchRoot(wanted || null);
        updateRunState();
      }).catch(function (error) { status(error.message, 'bad'); modelNote.textContent = 'Not connected'; });
    }
    function currentRoot() { return state.roots.filter(function (item) { return item.name === state.root; })[0] || null; }
    function updateRunState() {
      var item = currentRoot();
      runBtn.disabled = !item || !item.scriptsAvailable;
      runBtn.title = item && !item.scriptsAvailable ? 'Connect this folder as a git developer repository with the ci scope to run scripts.' : '';
    }
    function switchRoot(name) {
      state.root = name || null;
      state.tabs = []; state.active = -2; activate(-1);
      state.selectedPath = ''; state.selectedType = 'dir';
      resultsEl.hidden = true; treeEl.hidden = false;
      updateRunState();
      return loadTree();
    }
    function addRootDialog() {
      var name = el('input', { class: 'jvc-input', id: 'jvc-new-name', placeholder: 'my-project', 'aria-describedby': 'jvc-new-name-help' });
      var path = el('input', { class: 'jvc-input', id: 'jvc-new-path', placeholder: 'C:\\Users\\you\\projects\\my-project' });
      var err = el('p', { role: 'alert' });
      modal('Add a workspace folder', [
        el('p', { text: 'Only folders you add and approve are reachable. Secret files (.env, keys, tokens) and .git stay blocked.' }),
        el('label', {}, ['Name (lowercase letters, digits, hyphens)', name]), el('label', {}, ['Full folder path', path]), err
      ], [
        { label: 'Cancel', value: null },
        { label: 'Request approval', primary: true, onClick: function (button, close) {
          button.disabled = true; err.textContent = '';
          api('/api/workspace/roots/add', 'POST', { name: name.value.trim(), path: path.value.trim() }).then(function (result) {
            close(result);
          }, function (error) { err.textContent = error.message; button.disabled = false; });
          return false;
        } }
      ]).then(function (result) {
        if (!result) return;
        return awaitApproval(result, 'Approve adding this folder', null, 'Approve to let the Code view read and (with further approvals) edit files in this folder.').then(function (final) {
          if (succeeded(final)) { status('Folder added.', 'ok'); return loadRoots(true, name.value.trim().toLowerCase()); }
          if (final) status('Not added: ' + describe(final), 'bad');
        });
      });
    }
    function removeRoot() {
      if (!state.root) return;
      var name = state.root;
      modal('Remove workspace folder?', [el('p', { text: 'The folder "' + name + '" will no longer be reachable. Your files are not deleted.' })], [
        { label: 'Cancel', value: false }, { label: 'Request approval', primary: true, value: true }
      ]).then(function (ok) {
        if (!ok) return;
        return api('/api/workspace/roots/remove', 'POST', { name: name }).then(function (result) { return awaitApproval(result, 'Approve removing the folder'); })
          .then(function (final) { if (succeeded(final)) { status('Folder removed.', 'ok'); return loadRoots(false); } if (final) status(describe(final), 'bad'); });
      }).catch(function (error) { status(error.message, 'bad'); });
    }

    // ====== file tree ======
    function treeItem(entry) {
      var li = el('li', { role: 'none' });
      var isDir = entry.type === 'dir';
      var row = el('div', { class: 'jvc-row', role: 'treeitem', tabindex: '-1', 'aria-selected': 'false', 'data-path': entry.path, 'data-type': entry.type,
        'aria-expanded': isDir ? 'false' : null, 'aria-level': String(entry.path.split('/').length) }, [
        el('span', { class: 'ic', 'aria-hidden': 'true', text: isDir ? '\u25B8' : '\u00B7' }), entry.name
      ]);
      var children = isDir ? el('ul', { role: 'group', hidden: true }) : null;
      row.addEventListener('click', function () { selectNode(row); if (isDir) toggleDir(row, children, entry); else openFile(entry.path); });
      row.addEventListener('keydown', function (event) { treeKey(event, row, children, entry); });
      li.appendChild(row);
      if (children) li.appendChild(children);
      return li;
    }
    function selectNode(row) {
      if (state.selectedNode) { state.selectedNode.setAttribute('aria-selected', 'false'); state.selectedNode.tabIndex = -1; }
      state.selectedNode = row; row.setAttribute('aria-selected', 'true'); row.tabIndex = 0;
      state.selectedPath = row.getAttribute('data-path'); state.selectedType = row.getAttribute('data-type');
    }
    function visibleRows() { return Array.prototype.slice.call(treeEl.querySelectorAll('[role="treeitem"]')).filter(function (row) { return !row.closest('[hidden]'); }); }
    function treeKey(event, row, children, entry) {
      var rows = visibleRows(); var at = rows.indexOf(row);
      if (event.key === 'ArrowDown' && rows[at + 1]) { event.preventDefault(); selectNode(rows[at + 1]); rows[at + 1].focus(); }
      else if (event.key === 'ArrowUp' && rows[at - 1]) { event.preventDefault(); selectNode(rows[at - 1]); rows[at - 1].focus(); }
      else if (event.key === 'ArrowRight' && children && children.hidden) { event.preventDefault(); toggleDir(row, children, entry); }
      else if (event.key === 'ArrowLeft') {
        event.preventDefault();
        if (children && !children.hidden) toggleDir(row, children, entry);
        else { var parentList = row.closest('ul[role="group"]'); var parentRow = parentList && parentList.previousElementSibling; if (parentRow) { selectNode(parentRow); parentRow.focus(); } }
      } else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); row.click(); }
    }
    function toggleDir(row, children, entry) {
      var open = row.getAttribute('aria-expanded') === 'true';
      if (open) { children.hidden = true; row.setAttribute('aria-expanded', 'false'); row.firstChild.textContent = '\u25B8'; return Promise.resolve(); }
      children.hidden = false; row.setAttribute('aria-expanded', 'true'); row.firstChild.textContent = '\u25BE';
      if (children.getAttribute('data-loaded')) return Promise.resolve();
      return fillDir(children, entry.path);
    }
    function fillDir(list, path) {
      return api('/api/workspace/tree?root=' + encodeURIComponent(state.root) + '&path=' + encodeURIComponent(path)).then(function (data) {
        clear(list); list.setAttribute('data-loaded', '1');
        if (!data.entries.length) list.appendChild(el('li', { role: 'none' }, [el('div', { class: 'jvc-empty', text: 'Empty' })]));
        data.entries.forEach(function (entry) { list.appendChild(treeItem(entry)); });
        if (data.truncated) list.appendChild(el('li', { role: 'none' }, [el('div', { class: 'jvc-empty', text: 'List truncated; use search.' })]));
      }).catch(function (error) { status(error.message, 'bad'); });
    }
    function loadTree() {
      clear(treeEl); state.selectedNode = null;
      if (!state.root) { treeEl.appendChild(el('li', { role: 'none' }, [el('div', { class: 'jvc-empty', text: 'No folder selected.' })])); return Promise.resolve(); }
      return fillDir(treeEl, '').then(function () { var first = treeEl.querySelector('[role="treeitem"]'); if (first) first.tabIndex = 0; });
    }
    function refreshDir(path) {
      if (!path) return loadTree();
      var rows = treeEl.querySelectorAll('[role="treeitem"]');
      for (var i = 0; i < rows.length; i++) {
        if (rows[i].getAttribute('data-path') === path) { var list = rows[i].nextElementSibling; if (list && list.getAttribute('data-loaded')) return fillDir(list, path); }
      }
      return loadTree();
    }

    // ----- search -----
    function runSearch() {
      var q = searchInput.value.trim();
      if (!q || !state.root) return;
      status('Searching...');
      api('/api/workspace/search?root=' + encodeURIComponent(state.root) + '&q=' + encodeURIComponent(q)).then(function (data) {
        clear(resultsEl); resultsEl.hidden = false; treeEl.hidden = true;
        if (!data.results.length) resultsEl.appendChild(el('div', { class: 'jvc-empty', text: 'No results.' }));
        data.results.forEach(function (hit) {
          resultsEl.appendChild(el('button', { type: 'button', class: 'jvc-hit', onclick: function () { openFile(hit.path, hit.line); } }, [
            hit.path + (hit.line ? ':' + hit.line : ''), hit.text ? el('small', { text: hit.text }) : null
          ]));
        });
        resultsEl.appendChild(el('div', { class: 'jvc-empty', text: data.results.length + ' result(s)' + (data.truncated ? ' (limited; refine your search)' : '') + '. Esc clears search.' }));
        status(data.results.length + ' result(s)' + (data.truncated ? ', truncated' : ''));
      }).catch(function (error) { status(error.message, 'bad'); });
    }

    // ----- open a file -----
    function openFile(path, line) {
      for (var i = 0; i < state.tabs.length; i++) if (state.tabs[i].path === path) { activate(i); gotoLine(line); return Promise.resolve(); }
      status('Opening ' + path + '...');
      return api('/api/workspace/file?root=' + encodeURIComponent(state.root) + '&path=' + encodeURIComponent(path)).then(function (file) {
        state.tabs.push({ path: file.path, language: file.language, hash: file.hash, text: file.content, saved: file.content, scrollTop: 0, scrollLeft: 0 });
        activate(state.tabs.length - 1);
        gotoLine(line);
        status('Opened ' + file.path, 'ok');
      }).catch(function (error) { status(error.message, 'bad'); });
    }
    function gotoLine(line) {
      if (!line || !activeTab()) return;
      var lines = ta.value.split('\n'); var start = 0;
      for (var i = 0; i < Math.min(line - 1, lines.length); i++) start += lines[i].length + 1;
      ta.focus(); ta.setSelectionRange(start, start + (lines[line - 1] || '').length);
      ta.scrollTop = Math.max(0, (line - 4) * 20); syncScroll(); updateCaret();
    }

    // ====== saving (diff -> approval -> write) ======
    function saveActive() {
      var tab = activeTab();
      if (!tab) return Promise.resolve();
      saveViewState();
      if (!isDirty(tab)) { status('No changes to save.'); return Promise.resolve(); }
      var content = tab.text;
      status('Preparing diff...');
      return api('/api/workspace/diff', 'POST', { root: state.root, path: tab.path, content: content }).then(function (preview) {
        if (!preview.changed) { tab.saved = content; renderTabs(); status('No changes to save.'); return; }
        return modal('Review changes to ' + tab.path, [
          el('p', { text: 'Nothing is written until you approve. Review the diff first.' }), renderDiff(preview.diff)
        ], [{ label: 'Cancel', value: false }, { label: 'Save (needs approval)', primary: true, value: true }]).then(function (go) {
          if (!go) { status('Save cancelled.'); return; }
          return api('/api/workspace/write', 'POST', { root: state.root, path: tab.path, content: content, baseHash: preview.baseHash }).then(function (result) {
            if (result.unchanged) { status(result.message); return; }
            return awaitApproval(result, 'Approve saving ' + tab.path, result.diff);
          }).then(function (final) {
            if (final === undefined || final === null) return;
            if (!succeeded(final)) { status('Not saved: ' + describe(final), 'bad'); return; }
            return api('/api/workspace/file?root=' + encodeURIComponent(state.root) + '&path=' + encodeURIComponent(tab.path)).then(function (fresh) {
              tab.hash = fresh.hash; tab.saved = tab.text === content ? content : tab.saved;
              if (tab.text === content) tab.saved = tab.text;
              renderTabs(); updateContext(); status('Saved ' + tab.path, 'ok');
            });
          });
        });
      }).catch(function (error) { status(error.status === 409 ? error.message : 'Could not save: ' + error.message, 'bad'); });
    }

    // ====== create / rename / delete ======
    function targetDir() { return state.selectedType === 'dir' ? state.selectedPath : parentOf(state.selectedPath); }
    function newFile() {
      if (!state.root) return;
      var name = el('input', { class: 'jvc-input', value: (targetDir() ? targetDir() + '/' : '') + 'untitled.ts', 'aria-label': 'New file path' });
      var err = el('p', { role: 'alert' });
      modal('New file', [el('p', { text: 'Path relative to the folder. Creating needs your approval.' }), el('label', {}, ['Path', name]), err], [
        { label: 'Cancel', value: null },
        { label: 'Create (needs approval)', primary: true, onClick: function (button, close) {
          button.disabled = true;
          api('/api/workspace/create', 'POST', { root: state.root, path: name.value.trim(), content: '' }).then(close, function (error) { err.textContent = error.message; button.disabled = false; });
          return false;
        } }
      ]).then(function (result) {
        if (!result) return;
        return awaitApproval(result, 'Approve creating ' + name.value.trim(), result.diff).then(function (final) {
          if (succeeded(final)) { status('Created.', 'ok'); return refreshDir(parentOf(name.value.trim())).then(function () { return openFile(name.value.trim()); }); }
          if (final) status('Not created: ' + describe(final), 'bad');
        });
      });
    }
    function renameSelected() {
      if (!state.selectedPath) { status('Select a file or folder first.', 'warn'); return; }
      var from = state.selectedPath;
      var to = el('input', { class: 'jvc-input', value: from, 'aria-label': 'New path' });
      var err = el('p', { role: 'alert' });
      modal('Rename', [el('label', {}, ['New path for ' + from, to]), err], [
        { label: 'Cancel', value: null },
        { label: 'Rename (needs approval)', primary: true, onClick: function (button, close) {
          button.disabled = true;
          api('/api/workspace/rename', 'POST', { root: state.root, path: from, to: to.value.trim() }).then(close, function (error) { err.textContent = error.message; button.disabled = false; });
          return false;
        } }
      ]).then(function (result) {
        if (!result) return;
        return awaitApproval(result, 'Approve renaming ' + from).then(function (final) {
          if (succeeded(final)) {
            state.tabs.forEach(function (tab) { if (tab.path === from) tab.path = to.value.trim(); });
            renderTabs(); status('Renamed.', 'ok'); return loadTree();
          }
          if (final) status('Not renamed: ' + describe(final), 'bad');
        });
      });
    }
    function deleteSelected() {
      if (!state.selectedPath) { status('Select a file or folder first.', 'warn'); return; }
      var path = state.selectedPath;
      modal('Delete ' + path + '?', [el('p', { text: 'Files are moved to a recoverable trash folder; only empty folders can be deleted. This needs your approval.' })], [
        { label: 'Cancel', value: false }, { label: 'Delete (needs approval)', danger: true, primary: true, value: true }
      ]).then(function (ok) {
        if (!ok) return;
        return api('/api/workspace/delete', 'POST', { root: state.root, path: path }).then(function (result) { return awaitApproval(result, 'Approve deleting ' + path); }).then(function (final) {
          if (succeeded(final)) {
            for (var i = state.tabs.length - 1; i >= 0; i--) if (state.tabs[i].path === path) state.tabs.splice(i, 1);
            state.active = -2; activate(state.tabs.length ? 0 : -1); state.selectedPath = ''; status('Deleted.', 'ok'); return loadTree();
          }
          if (final) status('Not deleted: ' + describe(final), 'bad');
        }).catch(function (error) { status(error.message, 'bad'); });
      });
    }

    // ====== coding helper ======
    function addMessage(kind, text) {
      var message = el('div', { class: 'jvc-msg ' + kind }, [el('span', { class: 'who', text: kind === 'user' ? 'You' : kind === 'err' ? 'Problem' : 'Helper' }), el('span', { class: 'body', text: text || '' })]);
      chat.appendChild(message); chat.scrollTop = chat.scrollHeight;
      return message;
    }
    var DEFAULT_PROMPTS = {
      explain: 'Explain this code.', fix: 'Find and fix the problem in this code.', refactor: 'Refactor this code for clarity without changing behavior.',
      tests: 'Write tests for this code.', generate: 'Generate the file I describe.', chat: ''
    };
    function askHelper(action) {
      if (state.streaming) { status('The helper is still answering. Press Stop to cancel.', 'warn'); return; }
      if (!state.root) { status('Add and select a folder first.', 'warn'); return; }
      var typed = promptInput.value.trim();
      var message = typed || DEFAULT_PROMPTS[action];
      if (!message) { status('Type a question or choose an action.', 'warn'); return; }
      if (action === 'generate' && !typed) { status('Describe the file you want generated.', 'warn'); promptInput.focus(); return; }
      var tab = activeTab();
      if (tab) saveViewState();
      var request = { root: state.root, action: action, message: message, history: state.helperHistory.slice(-8) };
      if (tab) { request.path = tab.path; request.content = tab.text.length <= 300000 ? tab.text : undefined; var sel = selectionInfo(); if (sel) request.selection = sel; }
      addMessage('user', (action === 'chat' ? '' : '[' + action + '] ') + message);
      promptInput.value = '';
      var bubble = addMessage('helper', '');
      var body = bubble.querySelector('.body');
      var controller = new AbortController();
      state.streaming = controller;
      sendBtn.disabled = true; stopBtn.hidden = false; chat.setAttribute('aria-busy', 'true');
      var answer = '';
      var crypto = window.JarvisDeviceCrypto;
      var options = { method: 'POST', body: request, signal: controller.signal };
      var started = crypto && crypto.signedFetch ? crypto.signedFetch('/api/workspace/helper', options) : Promise.reject(new Error('Secure session is not available.'));
      started.then(function (response) {
        if (!response.ok) return response.json().catch(function () { return {}; }).then(function (p) { throw new Error(p.error || 'Helper request failed (HTTP ' + response.status + ')'); });
        var reader = response.body.getReader(); var decoder = new TextDecoder(); var buffer = '';
        function pump() {
          return reader.read().then(function (chunk) {
            if (chunk.done) return;
            buffer += decoder.decode(chunk.value, { stream: true });
            var parts = buffer.split('\n\n'); buffer = parts.pop();
            parts.forEach(function (part) {
              if (part.indexOf('data: ') !== 0) return;
              var event; try { event = JSON.parse(part.slice(6)); } catch (e) { return; }
              if (event.type === 'token') { answer += event.text; body.textContent = stripDiff(answer); chat.scrollTop = chat.scrollHeight; }
              else if (event.type === 'proposal') showProposal(event);
              else if (event.type === 'error') { bubble.classList.add('err'); body.textContent = event.message; }
            });
            return pump();
          });
        }
        return pump();
      }).catch(function (error) {
        if (controller.signal.aborted) { body.textContent = (body.textContent || '') + '\n[stopped]'; }
        else { bubble.classList.add('err'); body.textContent = error.message; }
      }).then(function () {
        state.streaming = null; sendBtn.disabled = false; stopBtn.hidden = true; chat.removeAttribute('aria-busy');
        if (answer) { state.helperHistory.push({ role: 'user', content: message }); state.helperHistory.push({ role: 'assistant', content: stripDiff(answer).slice(0, 2000) }); }
        status('Helper finished.');
      });
    }
    // The diff block is shown as a reviewable proposal card, not as chat text.
    function stripDiff(text) { return text.replace(/```(?:diff|patch)[\s\S]*?(?:```|$)/g, '[proposed change shown below]'); }
    function showProposal(event) {
      var card = el('div', { class: 'jvc-msg', role: 'group', 'aria-label': 'Proposed change' });
      card.appendChild(el('span', { class: 'who', text: 'Proposed change' }));
      if (!event.valid) {
        card.classList.add('err');
        card.appendChild(el('span', { text: 'The helper suggested a change that cannot be applied: ' + (event.error || 'invalid diff') + ' Nothing was changed.' }));
        chat.appendChild(card); chat.scrollTop = chat.scrollHeight; return;
      }
      card.appendChild(el('span', { text: 'Files: ' + event.files.join(', ') + '. Nothing is written until you click Apply and approve it.' }));
      card.appendChild(renderDiff(event.diff));
      var applyBtn = el('button', { type: 'button', class: 'jvc-btn primary', text: 'Apply (needs approval)' });
      var discardBtn = el('button', { type: 'button', class: 'jvc-btn', text: 'Discard' });
      var note = el('span', { role: 'status' });
      discardBtn.addEventListener('click', function () { card.remove(); status('Proposal discarded. Nothing was changed.'); });
      applyBtn.addEventListener('click', function () {
        applyBtn.disabled = true; discardBtn.disabled = true;
        api('/api/workspace/apply', 'POST', { root: state.root, diff: event.diff }).then(function (result) {
          return awaitApproval(result, 'Approve applying this change', result.diff);
        }).then(function (final) {
          if (succeeded(final)) { note.textContent = 'Applied.'; applyBtn.hidden = true; discardBtn.hidden = true; status('Change applied.', 'ok'); return reloadAfterApply(event.files); }
          applyBtn.disabled = false; discardBtn.disabled = false;
          if (final) note.textContent = 'Not applied: ' + describe(final);
        }).catch(function (error) { applyBtn.disabled = false; discardBtn.disabled = false; note.textContent = error.message; });
      });
      card.appendChild(el('div', { class: 'jvc-row-actions' }, [applyBtn, discardBtn, note]));
      chat.appendChild(card); chat.scrollTop = chat.scrollHeight;
    }
    function reloadAfterApply(files) {
      var chain = Promise.resolve();
      files.forEach(function (path) {
        var index = -1; state.tabs.forEach(function (tab, i) { if (tab.path === path) index = i; });
        if (index < 0) return;
        chain = chain.then(function () {
          return api('/api/workspace/file?root=' + encodeURIComponent(state.root) + '&path=' + encodeURIComponent(path)).then(function (fresh) {
            var tab = state.tabs[index];
            if (index === state.active) saveViewState();
            if (isDirty(tab)) { tab.hash = fresh.hash; status(path + ' changed on disk but has unsaved edits here; review before saving.', 'warn'); return; }
            tab.text = fresh.content; tab.saved = fresh.content; tab.hash = fresh.hash;
            if (index === state.active) { var keep = ta.scrollTop; ta.value = tab.text; refreshHighlight(); ta.scrollTop = keep; syncScroll(); }
          });
        });
      });
      return chain.then(function () { renderTabs(); return loadTree(); }).then(function () {
        if (files.length) return openFile(files[0]);
      });
    }

    // ----- run a project script (developer allowlist, approval) -----
    function runScript() {
      if (!state.root) return;
      var script = scriptSelect.value;
      runOut.hidden = false; runOut.textContent = 'Requesting approval...';
      api('/api/workspace/run', 'POST', { root: state.root, script: script }).then(function (result) {
        return awaitApproval(result, 'Approve running npm run ' + script, null, 'This runs the project\'s own "' + script + '" script in the connected repository. No other commands can be run from here.');
      }).then(function (final) {
        if (!final) { runOut.textContent = 'Not run.'; return; }
        var run = final.data && typeof final.data === 'object' ? final.data : null;
        runOut.textContent = (run && run.output ? run.output : describe(final)) + (run ? '\n[exit ' + run.exitCode + (run.timedOut ? ', timed out' : '') + ']' : '');
        status(succeeded(final) ? 'Script passed.' : 'Script failed: ' + describe(final), succeeded(final) ? 'ok' : 'bad');
      }).catch(function (error) { runOut.textContent = error.message; status(error.message, 'bad'); });
    }

    // warn on leaving with unsaved edits
    window.addEventListener('beforeunload', function (event) {
      if (state.tabs.some(isDirty)) { event.preventDefault(); event.returnValue = ''; }
    });

    updateContext();
    status('Loading folders...');
    loadRoots(false).then(function () { status(state.roots.length ? 'Ready.' : 'Add a folder to begin.'); });
  }

  window.JarvisStudioCode = { mount: mount, highlight: highlight };
  if (window.JarvisStudio && typeof window.JarvisStudio.registerView === 'function') {
    window.JarvisStudio.registerView('code', mount);
  }
})();
