// JARVIS owner panels (J-E10): plugins, workflows, visual workflow composer,
// developer assistant, memory management and gateway sites (J-E09).
// Every action is a signed request to a real backend route. State-changing actions
// become policy-checked tasks; approval-required ones surface the normal HUD
// approval card. Panels show "unavailable" when a route or session is missing.
(() => {
  'use strict';

  const TABS = [
    { id: 'plugins', label: 'Plugins' },
    { id: 'workflows', label: 'Workflows' },
    { id: 'composer', label: 'Composer' },
    { id: 'developer', label: 'Developer' },
    { id: 'memory', label: 'Memory' },
    { id: 'gateway', label: 'Gateway sites' },
  ];

  // ---------- small DOM helpers (no innerHTML: all text is untrusted) ----------
  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (value === undefined || value === null || value === false) continue;
      if (key === 'text') node.textContent = String(value);
      else if (key === 'class') node.className = value;
      else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value === true ? '' : String(value));
    }
    for (const child of [].concat(children || [])) {
      if (child === null || child === undefined || child === false) continue;
      node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    }
    return node;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
  function note(text, kind) { return el('p', { class: 'op-note' + (kind ? ' op-note-' + kind : ''), text }); }
  function button(label, onclick, extra) {
    return el('button', Object.assign({ type: 'button', class: 'hud-btn-mini op-btn', text: label, onclick }, extra || {}));
  }

  // ---------- signed API ----------
  class Unavailable extends Error {}
  async function api(path, method, body) {
    if (!window.JarvisDeviceCrypto || typeof window.JarvisDeviceCrypto.signedFetch !== 'function') {
      throw new Unavailable('Secure session is not available in this browser.');
    }
    let response;
    try {
      response = await window.JarvisDeviceCrypto.signedFetch(path, body === undefined ? { method: method || 'GET' } : { method: method || 'POST', body });
    } catch (error) {
      throw new Unavailable(error instanceof Error ? error.message : 'Network error');
    }
    const payload = await response.json().catch(() => ({}));
    if (response.status === 401 || response.status === 403 || response.status === 503 || response.status === 404) {
      throw new Unavailable(payload.error || 'Unavailable (HTTP ' + response.status + ')');
    }
    if (!response.ok) throw new Error(payload.error || 'Request failed (HTTP ' + response.status + ')');
    return payload;
  }

  /** Show a task result honestly; approval-required tasks reuse the HUD approval card. */
  function reportTask(result, status, label) {
    const state = result && result.state;
    if (state === 'AWAITING_APPROVAL' && result.approvalId) {
      if (typeof window.renderApprovalCard === 'function') {
        window.renderApprovalCard(result.approvalId, result.taskId, label, result.message);
      }
      status.replaceChildren(note('Waiting for your approval: confirm the card in the governance panel. Nothing has run yet.', 'warn'));
      return;
    }
    const verified = state === 'COMPLETED' && result.verified === true;
    status.replaceChildren(note((verified ? 'Done: ' : 'Not completed (' + String(state) + '): ') + String(result.message || ''), verified ? 'ok' : 'bad'));
    if (typeof window.refreshTaskHistory === 'function') window.refreshTaskHistory();
  }

  async function runOperation(operation, parameters, status, label) {
    status.replaceChildren(note('Submitting ' + operation + '…'));
    try {
      const result = await api('/api/panels/run', 'POST', { operation, parameters: parameters || {} });
      reportTask(result, status, label || operation);
      return result;
    } catch (error) {
      status.replaceChildren(note(error.message, 'bad'));
      return null;
    }
  }

  function showUnavailable(body, error) {
    clear(body);
    body.appendChild(note('Unavailable: ' + (error && error.message ? error.message : 'this panel needs an authenticated owner device.'), 'bad'));
  }

  const panels = {};
  window.JarvisOwnerPanels = { panels, api, el, note, button, runOperation, reportTask, showUnavailable, Unavailable };

  // ---------- tab shell ----------
  function mount() {
    const root = document.getElementById('hud-owner-panels');
    if (!root || root.dataset.mounted) return;
    root.dataset.mounted = 'true';
    const tabList = el('div', { class: 'op-tabs', role: 'tablist', 'aria-label': 'Owner panels' });
    const body = el('div', { class: 'op-body', role: 'tabpanel', id: 'op-body', tabindex: '0' });
    const toggle = el('button', { type: 'button', class: 'hud-btn-mini op-toggle', 'aria-expanded': 'false', 'aria-controls': 'op-content', text: 'OWNER PANELS' });
    const content = el('div', { id: 'op-content', class: 'op-content', hidden: true }, [tabList, body]);
    let active = null;
    async function select(id) {
      active = id;
      for (const tab of tabList.children) {
        const selected = tab.dataset.tab === id;
        tab.setAttribute('aria-selected', String(selected));
        tab.setAttribute('tabindex', selected ? '0' : '-1');
      }
      const activeTab = Array.from(tabList.children).find((tab) => tab.dataset.tab === id);
      if (activeTab) body.setAttribute('aria-labelledby', activeTab.id);
      clear(body);
      body.appendChild(note('Loading…'));
      const panel = panels[id];
      if (!panel) return showUnavailable(body, new Error('panel not loaded'));
      try { await panel(body); } catch (error) { showUnavailable(body, error); }
    }
    for (const tab of TABS) {
      tabList.appendChild(el('button', {
        type: 'button', id: 'op-tab-' + tab.id, role: 'tab', class: 'op-tab',
        'data-tab': tab.id, 'aria-selected': 'false', 'aria-controls': 'op-body',
        tabindex: '-1', text: tab.label,
        onclick: () => select(tab.id),
      }));
    }
    // Follow the ARIA tabs pattern: arrow keys move focus and selection; Home/End
    // jump to the first/last panel. Tab leaves the tablist normally.
    tabList.addEventListener('keydown', (event) => {
      const tabs = Array.from(tabList.children);
      const current = tabs.findIndex((tab) => tab.dataset.tab === active);
      if (current < 0) return;
      let next = current;
      if (event.key === 'ArrowRight') next = (current + 1) % tabs.length;
      else if (event.key === 'ArrowLeft') next = (current - 1 + tabs.length) % tabs.length;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = tabs.length - 1;
      else return;
      event.preventDefault();
      tabs[next].focus();
      select(tabs[next].dataset.tab);
    });
    toggle.addEventListener('click', () => {
      const open = content.hidden;
      content.hidden = !open;
      toggle.setAttribute('aria-expanded', String(open));
      if (open && !active) select(TABS[0].id);
    });
    root.append(toggle, content);
    window.JarvisOwnerPanels.refresh = () => { if (active) select(active); };
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();

// ---------- Plugins + Workflows ----------
(() => {
  'use strict';
  const P = window.JarvisOwnerPanels;
  if (!P) return;
  const { el, note, button, api, runOperation } = P;

  P.panels.plugins = async (body) => {
    const data = await api('/api/plugins');
    const status = el('div', { class: 'op-status', role: 'status', 'aria-live': 'polite' });
    const pathInput = el('input', { type: 'text', class: 'op-input', 'aria-label': 'Plugin manifest path', placeholder: 'Path to plugin manifest (.json) on this laptop' });
    const install = button('Install (needs approval)', () => {
      const path = pathInput.value.trim();
      if (!path) { status.replaceChildren(note('Enter a manifest path first.', 'bad')); return; }
      runOperation('plugin:install', { path }, status, 'Install plugin from ' + path);
    });
    const list = el('ul', { class: 'op-list' });
    if (!data.plugins.length) list.appendChild(el('li', { text: 'No plugins installed. Plugins are manifest-only bundles (no code, no shell).' }));
    for (const plugin of data.plugins) {
      const missing = plugin.requested.filter((permission) => !plugin.grants.includes(permission));
      list.appendChild(el('li', { class: 'op-item' }, [
        el('strong', { text: plugin.name + ' ' + plugin.version }),
        el('span', { class: 'op-meta', text: ' · ' + plugin.id + ' · ' + (plugin.enabled ? 'enabled' : 'disabled') }),
        el('div', { class: 'op-meta', text: 'Granted: ' + (plugin.grants.join(', ') || 'none') + (missing.length ? ' · Requested, not granted: ' + missing.join(', ') : '') }),
        el('div', { class: 'op-actions' }, [
          missing.length ? button('Grant requested (approval)', () => runOperation('plugin:grant', { id: plugin.id, permissions: missing }, status, 'Grant permissions to ' + plugin.id)) : null,
          plugin.grants.length ? button('Revoke all grants', () => runOperation('plugin:revoke', { id: plugin.id, permissions: plugin.grants }, status)) : null,
          plugin.enabled
            ? button('Disable', () => runOperation('plugin:disable', { id: plugin.id }, status))
            : button('Enable (approval)', () => runOperation('plugin:enable', { id: plugin.id }, status, 'Enable plugin ' + plugin.id)),
          button('Uninstall (approval)', () => runOperation('plugin:uninstall', { id: plugin.id }, status, 'Uninstall plugin ' + plugin.id)),
        ]),
      ]));
    }
    body.replaceChildren(el('div', { class: 'op-row' }, [pathInput, install]), list, status);
  };

  P.panels.workflows = async (body) => {
    const data = await api('/api/workflows');
    const status = el('div', { class: 'op-status', role: 'status', 'aria-live': 'polite' });
    const list = el('ul', { class: 'op-list' });
    if (!data.workflows.length) list.appendChild(el('li', { text: 'No workflows yet.' }));
    for (const workflow of data.workflows) {
      const history = el('ol', { class: 'op-history', hidden: true });
      const historyToggle = button('Versions', async () => {
        if (!history.hidden) { history.hidden = true; return; }
        try {
          const detail = await api('/api/workflows?name=' + encodeURIComponent(workflow.name));
          history.replaceChildren(...detail.history.map((version) => el('li', {
            text: 'v' + version.version + ' · ' + version.status + ' · ' + version.origin + ' · ' + version.steps.length + ' steps' + (version.note ? ' · ' + version.note : ''),
          })));
          history.hidden = false;
        } catch (error) { status.replaceChildren(note(error.message, 'bad')); }
      });
      const scheduleInput = el('input', { type: 'text', class: 'op-input op-input-short', 'aria-label': 'Schedule for ' + workflow.name, placeholder: 'e.g. every day at 9am' });
      list.appendChild(el('li', { class: 'op-item' }, [
        el('strong', { text: workflow.name }),
        el('span', { class: 'op-meta', text: ' v' + workflow.version + ' · ' + workflow.status + ' · ' + workflow.origin + ' · ' + workflow.steps + ' steps' }),
        el('div', { class: 'op-meta', text: workflow.description || '' }),
        el('div', { class: 'op-actions' }, [
          workflow.status === 'active' ? button('Run', () => runOperation('workflow:run', { name: workflow.name }, status, 'Run workflow ' + workflow.name)) : null,
          workflow.status === 'draft' ? button('Approve AI draft (approval)', () => runOperation('workflow:approve_draft', { name: workflow.name }, status, 'Approve workflow draft ' + workflow.name)) : null,
          workflow.status !== 'archived' ? button('Archive (approval)', () => runOperation('workflow:archive', { name: workflow.name }, status, 'Archive workflow ' + workflow.name)) : null,
          historyToggle,
        ]),
        workflow.status === 'active' ? el('div', { class: 'op-row' }, [
          scheduleInput,
          button('Schedule', async () => {
            const when = scheduleInput.value.trim();
            if (!when) { status.replaceChildren(note('Describe when to run it first.', 'bad')); return; }
            // Scheduling goes through the normal request path (scheduler + policy).
            try {
              const response = await window.JarvisDeviceCrypto.signedFetch('/api/request', { method: 'POST', body: { text: 'run workflow ' + workflow.name + ' ' + when } });
              const result = await response.json().catch(() => ({}));
              if (!response.ok) throw new Error(result.error || 'Scheduling failed (HTTP ' + response.status + ')');
              P.reportTask(result, status, 'Schedule workflow ' + workflow.name);
            } catch (error) { status.replaceChildren(note(error.message, 'bad')); }
          }),
        ]) : null,
        history,
      ]));
    }
    const goal = el('input', { type: 'text', class: 'op-input', 'aria-label': 'Goal for an AI-drafted workflow', placeholder: 'Describe a goal for an AI-drafted workflow' });
    const draftName = el('input', { type: 'text', class: 'op-input op-input-short', 'aria-label': 'Name for the AI draft', placeholder: 'name-like-this' });
    const draft = el('div', { class: 'op-row' }, [draftName, goal, button('Draft with AI', () => {
      runOperation('workflow:draft_ai', { name: draftName.value.trim(), goal: goal.value.trim() }, status, 'Draft workflow with AI');
    })]);
    body.replaceChildren(list, el('h4', { class: 'op-subhead', text: 'AI draft (advisory until you approve it)' }), draft, status);
  };
})();

// ---------- Visual workflow composer ----------
(() => {
  'use strict';
  const P = window.JarvisOwnerPanels;
  if (!P) return;
  const { el, note, button, api } = P;
  // Composer state survives tab switches within the page session.
  const state = { name: '', description: '', steps: [], nextId: 1, catalog: null };

  /** Parameter values are text; JSON-looking values (numbers, arrays, objects, booleans) are parsed. */
  function parseValue(text) {
    const trimmed = text.trim();
    if (/^(-?\d+(\.\d+)?|true|false|\[.*\]|\{.*\})$/s.test(trimmed)) {
      try { return JSON.parse(trimmed); } catch { /* keep as text */ }
    }
    return text;
  }

  function stepsPayload() {
    return state.steps.map((step) => {
      const parameters = {};
      for (const [key, value] of Object.entries(step.parameters)) if (value !== '') parameters[key] = parseValue(value);
      return { id: step.id, operation: step.operation, parameters, dependsOn: step.dependsOn.filter((dep) => state.steps.some((other) => other.id === dep)) };
    });
  }

  P.panels.composer = async (body) => {
    if (!state.catalog) state.catalog = (await api('/api/panels/catalog')).operations;
    const catalog = state.catalog;
    const byOp = new Map(catalog.map((rule) => [rule.operation, rule]));
    const status = el('div', { class: 'op-status', role: 'status', 'aria-live': 'polite' });
    const stepsBox = el('ol', { class: 'op-steps' });
    const boundaryBadges = new Map();

    function render() {
      stepsBox.replaceChildren();
      state.steps.forEach((step, index) => {
        const rule = byOp.get(step.operation);
        const select = el('select', { class: 'op-input', 'aria-label': 'Operation for step ' + step.id });
        for (const option of catalog) {
          select.appendChild(el('option', { value: option.operation, text: option.operation + (option.name !== option.operation ? ' — ' + option.name : ''), selected: option.operation === step.operation }));
        }
        select.addEventListener('change', () => { step.operation = select.value; step.parameters = {}; render(); });
        const params = el('div', { class: 'op-params' });
        for (const key of (rule ? rule.allowedParameters : [])) {
          const input = el('input', { type: 'text', class: 'op-input op-input-short', 'aria-label': step.id + ' ' + key, placeholder: key, value: step.parameters[key] || '' });
          input.addEventListener('input', () => { step.parameters[key] = input.value; });
          params.appendChild(el('label', { class: 'op-param' }, [key + ' ', input]));
        }
        const deps = el('div', { class: 'op-deps' });
        for (const other of state.steps.slice(0, index)) {
          const box = el('input', { type: 'checkbox', checked: step.dependsOn.includes(other.id) });
          box.addEventListener('change', () => {
            step.dependsOn = box.checked ? [...new Set([...step.dependsOn, other.id])] : step.dependsOn.filter((dep) => dep !== other.id);
          });
          deps.appendChild(el('label', { class: 'op-dep' }, [box, ' after ' + other.id]));
        }
        const badge = el('span', {
          class: 'op-badge ' + (rule && !rule.requiresApproval ? 'op-badge-auto' : 'op-badge-approval'),
          text: rule ? (rule.requiresApproval ? 'APPROVAL · ' + rule.riskTier : 'no approval · ' + rule.riskTier) : 'unknown',
        });
        boundaryBadges.set(step.id, badge);
        stepsBox.appendChild(el('li', { class: 'op-step' }, [
          el('div', { class: 'op-row' }, [el('strong', { text: step.id }), select, badge]),
          params,
          deps.childNodes.length ? deps : null,
          el('div', { class: 'op-actions' }, [
            button('↑', () => { if (index > 0) { [state.steps[index - 1], state.steps[index]] = [state.steps[index], state.steps[index - 1]]; render(); } }, { 'aria-label': 'Move ' + step.id + ' up' }),
            button('↓', () => { if (index < state.steps.length - 1) { [state.steps[index + 1], state.steps[index]] = [state.steps[index], state.steps[index + 1]]; render(); } }, { 'aria-label': 'Move ' + step.id + ' down' }),
            button('Remove', () => {
              state.steps.splice(index, 1);
              for (const other of state.steps) other.dependsOn = other.dependsOn.filter((dep) => dep !== step.id);
              render();
            }),
          ]),
        ]));
      });
      if (!state.steps.length) stepsBox.appendChild(el('li', { class: 'op-meta', text: 'No steps yet. Add a step to start.' }));
    }

    const nameInput = el('input', { type: 'text', class: 'op-input op-input-short', 'aria-label': 'Workflow name', placeholder: 'workflow-name', value: state.name });
    nameInput.addEventListener('input', () => { state.name = nameInput.value.trim(); });
    const descInput = el('input', { type: 'text', class: 'op-input', 'aria-label': 'Workflow description', placeholder: 'What this workflow does', value: state.description });
    descInput.addEventListener('input', () => { state.description = descInput.value; });

    const addStep = button('Add step', () => {
      state.steps.push({ id: 's' + state.nextId++, operation: catalog[0] ? catalog[0].operation : '', parameters: {}, dependsOn: state.steps.length ? [state.steps[state.steps.length - 1].id] : [] });
      render();
    });
    const validate = button('Validate', async () => {
      try {
        const result = await api('/api/workflows/validate', 'POST', { steps: stepsPayload() });
        for (const boundary of result.boundaries) {
          const badge = boundaryBadges.get(boundary.id);
          if (badge && !boundary.allowed) { badge.textContent = 'NOT ALLOWED'; badge.className = 'op-badge op-badge-bad'; }
        }
        status.replaceChildren(result.valid
          ? note('Valid. Run order: ' + result.order.join(' → ') + '. ' + result.boundaries.filter((b) => b.requiresApproval).length + ' step(s) will ask for approval when run.', 'ok')
          : note('Invalid: ' + result.problems.join(' '), 'bad'));
      } catch (error) { status.replaceChildren(note(error.message, 'bad')); }
    });
    const save = button('Save as new version (approval)', async () => {
      try {
        const result = await api('/api/workflows/compose', 'POST', { name: state.name, description: state.description, steps: stepsPayload() });
        P.reportTask(result, status, 'Save composed workflow ' + state.name);
      } catch (error) { status.replaceChildren(note(error.message, 'bad')); }
    });

    render();
    body.replaceChildren(
      el('div', { class: 'op-row' }, [nameInput, descInput]),
      stepsBox,
      el('div', { class: 'op-actions' }, [addStep, validate, save]),
      note('Steps run in dependency order. Every step is still checked by the policy gateway at run time; approval badges come from the policy table.'),
      status,
    );
  };
})();

// ---------- Developer assistant, Memory, Gateway sites ----------
(() => {
  'use strict';
  const P = window.JarvisOwnerPanels;
  if (!P) return;
  const { el, note, button, api, runOperation } = P;

  P.panels.developer = async (body) => {
    const data = await api('/api/developer/repos');
    const status = el('div', { class: 'op-status', role: 'status', 'aria-live': 'polite' });
    const repos = Array.isArray(data.repos) ? data.repos : [];
    const suggestions = Array.isArray(data.suggestions) ? data.suggestions : [];
    const repoList = el('ul', { class: 'op-list' });
    if (!repos.length) repoList.appendChild(el('li', { text: data.error || 'No repositories connected. Say "connect repo <name> at <path> with read,suggest".' }));
    for (const repo of repos) {
      repoList.appendChild(el('li', { class: 'op-item' }, [
        el('strong', { text: repo.name }),
        el('span', { class: 'op-meta', text: ' · ' + (repo.scopes || []).join(', ') }),
        el('div', { class: 'op-actions' }, [
          button('Git status', () => runOperation('dev:git_status', { repo: repo.name }, status)),
          button('Disconnect (approval)', () => runOperation('dev:repo_disconnect', { name: repo.name }, status, 'Disconnect repo ' + repo.name)),
        ]),
      ]));
    }
    const suggestionList = el('ul', { class: 'op-list' });
    if (!suggestions.length) suggestionList.appendChild(el('li', { text: 'No suggestions yet. Ask "suggest a fix for <file> in <repo>: …".' }));
    for (const suggestion of suggestions) {
      const diff = el('pre', { class: 'op-diff', hidden: true, text: suggestion.diff || '(no diff — explanation only)' });
      suggestionList.appendChild(el('li', { class: 'op-item' }, [
        el('strong', { text: suggestion.repo + ' · ' + suggestion.targetPath }),
        el('span', { class: 'op-meta', text: ' · ' + suggestion.kind + ' · ' + suggestion.status }),
        el('div', { class: 'op-meta', text: suggestion.explanation.slice(0, 400) }),
        el('div', { class: 'op-actions' }, [
          button('View diff', () => { diff.hidden = !diff.hidden; }),
          suggestion.status === 'draft' && suggestion.diff
            ? button('Apply to working tree (approval)', () => runOperation('dev:apply_suggestion', { repo: suggestion.repo, suggestionId: suggestion.id }, status, 'Apply suggestion ' + suggestion.id))
            : null,
        ]),
        diff,
      ]));
    }
    body.replaceChildren(
      el('h4', { class: 'op-subhead', text: 'Connected repositories' }), repoList,
      el('h4', { class: 'op-subhead', text: 'Suggestions (drafts, never committed automatically)' }), suggestionList,
      note('Commits, pushes and PR drafts go through the normal approval cards; main and dev are always refused.'),
      status,
    );
  };

  P.panels.memory = async (body) => {
    const [list, manager] = await Promise.all([api('/api/memory'), api('/api/memory/manager').catch(() => null)]);
    const status = el('div', { class: 'op-status', role: 'status', 'aria-live': 'polite' });
    const records = Array.isArray(list.records) ? list.records : [];
    const recordList = el('ul', { class: 'op-list' });
    if (!records.length) recordList.appendChild(el('li', { text: 'No long-term memories saved.' }));
    for (const record of records) {
      const editor = el('textarea', { class: 'op-input', rows: '2', 'aria-label': 'Correct memory ' + record.id, hidden: true });
      editor.value = record.content;
      recordList.appendChild(el('li', { class: 'op-item' }, [
        el('span', { class: 'op-meta', text: record.category + (record.expiresAt ? ' · expires ' + new Date(record.expiresAt).toLocaleDateString() : '') + ' · ' }),
        el('span', { text: record.content }),
        editor,
        el('div', { class: 'op-actions' }, [
          button('Edit', () => {
            if (editor.hidden) { editor.hidden = false; return; }
            runOperation('memory:update', { id: record.id, content: editor.value.trim() }, status, 'Correct memory ' + record.id);
          }),
          button('Delete (approval)', () => runOperation('memory:delete', { id: record.id }, status, 'Delete memory ' + record.id)),
        ]),
      ]));
    }
    const exportButton = button('Export', async () => {
      try {
        const payload = await api('/api/memory/export');
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
        const link = el('a', { href: URL.createObjectURL(blob), download: 'jarvis-memory-' + new Date().toISOString().slice(0, 10) + '.json' });
        link.click();
        setTimeout(() => URL.revokeObjectURL(link.href), 1000);
        status.replaceChildren(note('Exported ' + payload.records.length + ' memories (plaintext file — store it securely).', 'ok'));
      } catch (error) { status.replaceChildren(note(error.message, 'bad')); }
    });
    const importInput = el('input', { type: 'file', accept: 'application/json,.json', class: 'op-input', 'aria-label': 'Memory export file to import' });
    const importButton = button('Import file (each new record needs approval)', async () => {
      const file = importInput.files && importInput.files[0];
      if (!file) { status.replaceChildren(note('Choose an export file first.', 'bad')); return; }
      try {
        const parsed = JSON.parse(await file.text());
        const result = await api('/api/memory/import', 'POST', { export: parsed });
        const skipped = Array.isArray(result.skipped) ? result.skipped.length : 0;
        if (result.state) P.reportTask(result, status, 'Import memories');
        status.appendChild(note((result.newRecords ?? result.imported ?? 0) + ' new record(s); ' + skipped + ' skipped (duplicates, expired or not storable).'));
      } catch (error) { status.replaceChildren(note(error instanceof SyntaxError ? 'That file is not valid JSON.' : error.message, 'bad')); }
    });

    const learning = el('div', { class: 'op-item' });
    if (manager) {
      const s = manager.status || {};
      learning.append(
        el('div', { class: 'op-meta', text: 'Working memory: ' + ((s.working && s.working.entries) || 0) + ' entries in ' + ((s.working && s.working.scopes) || 0) + ' scopes (RAM only).' }),
        el('div', { class: 'op-row' }, [
          el('span', { text: 'Learning is ' + (s.learningEnabled ? 'ON' : 'OFF') + ' · ' + (s.pendingCandidates || 0) + ' pending suggestion(s)' }),
          button(s.learningEnabled ? 'Turn learning off' : 'Turn learning on', async () => {
            try { await api('/api/memory/learning', 'POST', { enabled: !s.learningEnabled }); P.refresh && P.refresh(); }
            catch (error) { status.replaceChildren(note(error.message, 'bad')); }
          }),
        ]),
      );
      const candidates = el('ul', { class: 'op-list' });
      for (const candidate of manager.candidates || []) {
        const decide = async (decision) => {
          try { await api('/api/memory/candidates/decide', 'POST', { id: candidate.id, decision }); P.refresh && P.refresh(); }
          catch (error) { status.replaceChildren(note(error.message, 'bad')); }
        };
        candidates.appendChild(el('li', { class: 'op-item' }, [
          el('span', { class: 'op-meta', text: candidate.category + ' · from ' + candidate.source.kind + ' · ' }),
          el('span', { text: candidate.content }),
          el('div', { class: 'op-actions' }, [button('Approve', () => decide('approve')), button('Reject', () => decide('reject'))]),
        ]));
      }
      learning.append(candidates);
    } else {
      learning.append(note('Memory manager unavailable (owner control token not configured).', 'bad'));
    }
    body.replaceChildren(
      el('h4', { class: 'op-subhead', text: 'Long-term memory (encrypted)' }), recordList,
      el('div', { class: 'op-row' }, [exportButton, importInput, importButton]),
      el('h4', { class: 'op-subhead', text: 'Working memory and learning' }), learning,
      status,
    );
  };

  P.panels.gateway = async (body) => {
    const data = await api('/api/gateway/sites');
    const status = el('div', { class: 'op-status', role: 'status', 'aria-live': 'polite' });
    const keyBox = el('div', { class: 'op-key', role: 'region', 'aria-label': 'New site key' });
    for (const pending of data.pendingReveals || []) {
      keyBox.appendChild(el('div', { class: 'op-row' }, [
        el('span', { text: 'New key for client ' + pending.clientId + ' is ready (expires ' + new Date(pending.expiresAt).toLocaleTimeString() + ').' }),
        button('Show key once', async () => {
          try {
            const revealed = await api('/api/gateway/sites/reveal', 'POST', { revealToken: pending.revealToken });
            keyBox.replaceChildren(
              note('Copy this key into the site\'s server-side secrets now. It will not be shown again.', 'warn'),
              el('code', { class: 'op-secret', text: revealed.apiKey }),
            );
          } catch (error) { status.replaceChildren(note(error.message, 'bad')); }
        }),
      ]));
    }
    const list = el('ul', { class: 'op-list' });
    if (!data.sites.length) list.appendChild(el('li', { text: 'No site keys yet.' }));
    for (const site of data.sites) {
      const usage = site.usage || {};
      const rpm = el('input', { type: 'number', class: 'op-input op-input-short', min: '1', max: '600', value: String(site.limits.requestsPerMinute), 'aria-label': 'Requests per minute for ' + site.name });
      const tokens = el('input', { type: 'number', class: 'op-input op-input-short', min: '16', max: '4096', value: String(site.limits.maxOutputTokens), 'aria-label': 'Max output tokens for ' + site.name });
      const profiles = el('input', { type: 'text', class: 'op-input op-input-short', value: (site.allowedProfiles || []).join(','), placeholder: 'any profile', 'aria-label': 'Allowed profiles for ' + site.name });
      list.appendChild(el('li', { class: 'op-item' + (site.revokedAt ? ' op-revoked' : '') }, [
        el('strong', { text: site.name }),
        el('span', { class: 'op-meta', text: ' · ' + site.id + ' · ' + (site.revokedAt ? 'REVOKED' : 'active') }),
        el('div', { class: 'op-meta', text: 'Usage: ' + (usage.requests || 0) + ' requests, ' + (usage.errors || 0) + ' errors, ' + (usage.inputChars || 0) + ' chars in, ' + (usage.outputChars || 0) + ' chars out' + (usage.lastUsedAt ? ', last ' + new Date(usage.lastUsedAt).toLocaleString() : '') }),
        site.revokedAt ? null : el('div', { class: 'op-row' }, [
          el('label', { class: 'op-param' }, ['req/min ', rpm]),
          el('label', { class: 'op-param' }, ['max tokens ', tokens]),
          el('label', { class: 'op-param' }, ['profiles ', profiles]),
          button('Save limits (approval)', () => runOperation('gateway:site_update', {
            id: site.id,
            limits: { requestsPerMinute: Number(rpm.value), maxOutputTokens: Number(tokens.value) },
            allowedProfiles: profiles.value.split(',').map((item) => item.trim()).filter(Boolean),
          }, status, 'Update gateway site ' + site.name)),
          button('Revoke', () => runOperation('gateway:site_revoke', { id: site.id }, status, 'Revoke gateway site ' + site.name)),
        ]),
      ]));
    }
    const name = el('input', { type: 'text', class: 'op-input op-input-short', placeholder: 'site-name', 'aria-label': 'New site name' });
    const newProfiles = el('input', { type: 'text', class: 'op-input op-input-short', placeholder: 'profiles (optional, comma separated)', 'aria-label': 'Allowed profiles for the new site' });
    const create = button('Create key (approval)', () => runOperation('gateway:site_create', {
      name: name.value.trim(),
      allowedProfiles: newProfiles.value.split(',').map((item) => item.trim()).filter(Boolean),
    }, status, 'Create gateway site key ' + name.value.trim()));
    body.replaceChildren(
      keyBox, list,
      el('h4', { class: 'op-subhead', text: 'New site key' }),
      el('div', { class: 'op-row' }, [name, newProfiles, create]),
      note('After you approve, reopen this tab to reveal the key once. Keys are stored only as hashes.'),
      status,
    );
  };
})();
