/* JARVIS Studio - Models view.
 * Providers, model catalog, routing rules, budget and spend, metrics and a test prompt.
 * Registers itself with the Studio shell: window.JarvisStudio.registerView('models', mountFn).
 * No dependencies; DOM nodes only (no innerHTML), so model names and errors can never inject markup.
 * API keys and URLs are never shown: the server does not send them.
 */
(function () {
  'use strict';
  var TASKS = ['chat', 'code', 'reasoning', 'summarize', 'extract', 'embed', 'vision'];
  var SVG_NS = 'http://www.w3.org/2000/svg';

  function el(tag, props, children) {
    var node = document.createElement(tag);
    Object.keys(props || {}).forEach(function (key) {
      var value = props[key];
      if (value === undefined || value === null || value === false) return;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key === 'value') node.value = value;
      else if (key === 'checked') node.checked = Boolean(value);
      else if (key.slice(0, 2) === 'on' && typeof value === 'function') node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value === true ? '' : String(value));
    });
    (children || []).forEach(function (child) {
      if (child === null || child === undefined || child === false) return;
      node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    });
    return node;
  }
  function usd(value) { return '$' + (value || 0).toFixed(value >= 1 ? 2 : 4); }
  function card(title, children) { return el('section', { class: 'card' }, [el('h3', { text: title })].concat(children || [])); }
  function stat(label, value) { return el('div', { class: 'stat' }, [el('span', { class: 'muted small', text: label }), el('b', { text: value })]); }
  function table(headers, rows) {
    return el('div', { class: 'table-wrap' }, [el('table', {}, [
      el('thead', {}, [el('tr', {}, headers.map(function (header) { return el('th', { text: header, scope: 'col' }); }))]),
      el('tbody', {}, rows.map(function (row) {
        return el('tr', {}, row.map(function (cell) { return el('td', {}, [cell instanceof Node ? cell : String(cell === null || cell === undefined ? '' : cell)]); }));
      }))
    ])]);
  }
  function badge(text, kind) { return el('span', { class: 'badge' + (kind ? ' ' + kind : ''), text: text }); }

  function sparkline(values) {
    var width = 120, height = 28;
    var svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('width', String(width));
    svg.setAttribute('height', String(height));
    svg.setAttribute('viewBox', '0 0 ' + width + ' ' + height);
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', values.length ? 'Latency trend over the last ' + values.length + ' calls' : 'No latency data yet');
    if (values.length < 2) return svg;
    var min = Math.min.apply(null, values), max = Math.max.apply(null, values), span = max - min || 1;
    var points = values.map(function (value, index) {
      return (index / (values.length - 1) * (width - 4) + 2).toFixed(1) + ',' + (height - 3 - (value - min) / span * (height - 6)).toFixed(1);
    }).join(' ');
    var line = document.createElementNS(SVG_NS, 'polyline');
    line.setAttribute('points', points);
    line.setAttribute('fill', 'none');
    line.setAttribute('stroke', 'currentColor');
    line.setAttribute('stroke-width', '1.5');
    svg.appendChild(line);
    return svg;
  }

  async function mount(container, studio) {
    var api = studio.api;
    var inner = el('div', { class: 'view-inner stack' });
    container.replaceChildren(inner);
    var status = el('div', { role: 'status', 'aria-live': 'polite', class: 'muted small' });

    function note(message, error) {
      status.textContent = message || '';
      status.className = error ? 'notice error' : 'muted small';
    }

    async function postConfig(config) {
      var path = '/api/llm/config';
      try {
        return await api(path, { method: 'POST', body: { config: config } });
      } catch (error) {
        if (error && error.status === 401 && /authenticator/i.test(error.message || '') && window.JarvisStudio && window.JarvisStudio.stepUpPost) {
          return window.JarvisStudio.stepUpPost(path, { config: config });
        }
        throw error;
      }
    }

    async function render() {
      var results = await Promise.all([api('/api/llm/status'), api('/api/llm/catalog'), api('/api/llm/config'), api('/api/llm/metrics')]);
      var st = results[0], catalog = results[1], cfg = results[2].config, metrics = results[3];
      var nodes = [];

      // ---- providers
      nodes.push(card('Providers', [
        el('p', { class: 'muted small', text: 'Routing mode: ' + st.mode + '. Local providers are free and the only ones that ever see private data. Cloud providers are paid and are used only when you authorize them below.' }),
        table(['Provider', 'Type', 'Configured', 'Health', 'Circuit', 'Default model'], st.providers.map(function (p) {
          var health = p.health ? badge(p.health.ok ? 'healthy' + (p.health.latencyMs !== undefined ? ' ' + Math.round(p.health.latencyMs) + ' ms' : '') : 'down' + (p.health.detail ? ' (' + p.health.detail + ')' : ''), p.health.ok ? 'ok' : 'bad') : badge('not checked');
          return [p.label, badge(p.local ? 'local, free' : 'paid cloud'), badge(p.configured ? 'yes' : 'no', p.configured ? 'ok' : ''), p.configured ? health : '-', p.breaker ? p.breaker.state + (p.breaker.retryInSeconds ? ' (' + p.breaker.retryInSeconds + 's)' : '') : '-', p.defaultModel || '-'];
        })),
        el('div', { class: 'row' }, [el('button', { type: 'button', class: 'btn small', text: 'Run health checks', onclick: async function (event) {
          event.target.disabled = true; note('Checking providers...');
          try { await api('/api/llm/health', { method: 'POST', body: {} }); await render(); note('Health checks finished.'); } catch (error) { note(error.message, true); } finally { event.target.disabled = false; }
        } })]),
        el('p', { class: 'muted small', text: 'Cloud keys are read from environment variables on the host and are never shown here.' })
      ]));

      // ---- budget
      var b = st.budget;
      var budgetInput = el('input', { id: 'llm-budget', type: 'number', min: '0', max: '100000', step: '0.5', value: String(b.monthlyBudgetUsd) });
      var perRequestInput = el('input', { id: 'llm-per-request', type: 'number', min: '0', max: '1000', step: '0.05', value: String(b.perRequestMaxUsd) });
      var globalToggle = el('input', { id: 'llm-global', type: 'checkbox', checked: b.globalAuthorized });
      var taskBoxes = TASKS.map(function (task) {
        return { task: task, box: el('input', { type: 'checkbox', checked: b.authorizedTasks.indexOf(task) >= 0, 'aria-label': 'Authorize cloud for ' + task }) };
      });
      nodes.push(card('Budget and spend', [
        el('div', { class: 'stat-grid' }, [
          stat('Spent this month (' + b.month + ')', usd(b.spentUsd)), stat('Monthly budget', b.monthlyBudgetUsd > 0 ? usd(b.monthlyBudgetUsd) : '$0 (no paid use)'),
          stat('Remaining', usd(b.remainingUsd)), stat('Per-request limit', usd(b.perRequestMaxUsd))
        ]),
        el('p', { class: 'muted small', text: 'Zero cost is the default. A paid provider is used only when cloud is authorized (all tasks, or the tasks ticked below), the request holds no private data, and the monthly budget has room. The budget is a hard stop. ' + st.pricingNote }),
        el('div', { class: 'stack' }, [
          el('label', { class: 'inline-check', for: 'llm-global' }, [globalToggle, el('span', { text: 'Authorize cloud for every non-private task' })]),
          el('div', { class: 'row' }, taskBoxes.map(function (item) { return el('label', { class: 'inline-check' }, [item.box, el('span', { text: item.task })]); })),
          el('label', { for: 'llm-budget', text: 'Monthly budget (USD)' }), budgetInput,
          el('label', { for: 'llm-per-request', text: 'Per-request limit (USD)' }), perRequestInput,
          el('button', { type: 'button', class: 'btn primary', text: 'Save budget and authorization', onclick: async function () {
            var next = { cloud: {
              globalAuthorized: globalToggle.checked,
              authorizedTasks: taskBoxes.filter(function (item) { return item.box.checked; }).map(function (item) { return item.task; }),
              monthlyBudgetUsd: Number(budgetInput.value), perRequestMaxUsd: Number(perRequestInput.value)
            } };
            try { var saved = await postConfig(next); await render(); note(saved.escalation ? 'Saved. Paid use is now allowed within the budget.' : 'Saved.'); } catch (error) { note(error.message, true); }
          } })
        ])
      ]));

      // ---- catalog
      nodes.push(card('Model catalog', [
        el('h4', { text: 'Local models' }),
        catalog.local.length ? table(['Model', 'Provider', 'Family', 'Size', 'Context', 'Capabilities'], catalog.local.map(function (m) {
          return [m.name, m.provider, m.family, m.parameterSize || (m.sizeBillions ? m.sizeBillions + 'B' : '-'), m.contextLength ? m.contextLength.toLocaleString() : '-', m.capabilities.join(', ')];
        })) : el('p', { class: 'muted', text: 'No local models found. Start Ollama (or a local OpenAI-compatible server) and pull a model.' }),
        el('div', { class: 'row' }, [el('button', { type: 'button', class: 'btn small', text: 'Refresh catalog', onclick: async function () {
          try { await api('/api/llm/catalog?refresh=1'); await render(); } catch (error) { note(error.message, true); }
        } })]),
        el('h4', { text: 'Cloud models (prices per 1M tokens; verify current pricing)' }),
        catalog.cloud.length ? table(['Provider', 'Model', 'Tier', 'Input', 'Output'], catalog.cloud.map(function (m) {
          return [m.provider, m.model + (m.isDefault ? ' (default)' : ''), m.tier, usd(m.inputPer1M), usd(m.outputPer1M)];
        })) : el('p', { class: 'muted', text: 'No cloud providers configured.' })
      ]));

      // ---- routing rules
      var ruleInputs = {};
      nodes.push(card('Routing rules', [
        el('p', { class: 'muted small', text: 'For each task, local models are ranked by the name fragments below (best first). Size bias "small" picks the smallest matching model, which suits fast JSON extraction.' }),
        table(['Task', 'Preferred model names (comma separated)', 'Size bias', 'Cloud min tier'], TASKS.map(function (task) {
          var rule = cfg.rules[task];
          var prefer = el('input', { type: 'text', value: rule.preferModels.join(', '), maxlength: '400', 'aria-label': 'Preferred models for ' + task });
          var bias = el('select', { 'aria-label': 'Size bias for ' + task }, ['any', 'small', 'large'].map(function (v) { return el('option', { value: v, text: v, selected: v === rule.sizeBias }); }));
          var tier = el('select', { 'aria-label': 'Cloud tier for ' + task }, ['small', 'medium', 'large'].map(function (v) { return el('option', { value: v, text: v, selected: v === rule.cloudMinTier }); }));
          ruleInputs[task] = { prefer: prefer, bias: bias, tier: tier };
          return [task, prefer, bias, tier];
        })),
        el('button', { type: 'button', class: 'btn primary', text: 'Save routing rules', onclick: async function () {
          var rules = {};
          TASKS.forEach(function (task) {
            var r = ruleInputs[task];
            rules[task] = { preferModels: r.prefer.value.split(',').map(function (s) { return s.trim(); }).filter(Boolean), sizeBias: r.bias.value, cloudMinTier: r.tier.value };
          });
          try { await postConfig({ rules: rules }); await render(); note('Routing rules saved.'); } catch (error) { note(error.message, true); }
        } })
      ]));

      // ---- metrics
      nodes.push(card('Performance', [
        metrics.summaries.length ? table(['Provider', 'Model', 'Calls', 'Error rate', 'Avg latency', 'p95', 'TTFT', 'Tokens/s', 'Fallbacks', 'Cost', 'Latency trend'], metrics.summaries.map(function (m) {
          return [m.provider, m.model, m.calls, Math.round(m.errorRate * 100) + '%', Math.round(m.avgLatencyMs) + ' ms', Math.round(m.p95LatencyMs) + ' ms',
            m.avgTtftMs === null ? '-' : Math.round(m.avgTtftMs) + ' ms', m.avgTokensPerSec === null ? '-' : m.avgTokensPerSec, m.fallbacks, usd(m.costUsd), sparkline(m.latencySeries)];
        })) : el('p', { class: 'muted', text: 'No calls recorded yet. Only timings, token counts and costs are stored, never prompts or replies.' })
      ]));

      // ---- test prompt
      var providerSelect = el('select', { id: 'llm-test-provider', 'aria-label': 'Provider to test' }, st.providers.filter(function (p) { return p.configured; }).map(function (p) { return el('option', { value: p.id, text: p.label + (p.local ? '' : ' (paid)') }); }));
      var modelInput = el('input', { id: 'llm-test-model', type: 'text', maxlength: '128', placeholder: 'Model (optional)', 'aria-label': 'Model to test' });
      var promptInput = el('input', { id: 'llm-test-prompt', type: 'text', maxlength: '500', value: 'Reply with the single word: ready.', 'aria-label': 'Test prompt' });
      var output = el('pre', { class: 'muted small', role: 'status', 'aria-live': 'polite' });
      nodes.push(card('Test a model', [
        el('p', { class: 'muted small', text: 'Sends one short prompt to the chosen provider. A paid provider will refuse unless it is authorized and within budget; the test never falls back to another provider.' }),
        el('div', { class: 'row' }, [providerSelect, modelInput]), promptInput,
        el('button', { type: 'button', class: 'btn', text: 'Run test prompt', onclick: async function (event) {
          event.target.disabled = true; output.textContent = 'Running...';
          try {
            var body = { provider: providerSelect.value, prompt: promptInput.value };
            if (modelInput.value.trim()) body.model = modelInput.value.trim();
            var r = await api('/api/llm/test', { method: 'POST', body: body });
            output.textContent = r.ok
              ? r.provider + ' / ' + r.model + ' - ' + Math.round(r.latencyMs) + ' ms, ' + r.usage.inputTokens + ' in / ' + r.usage.outputTokens + ' out tokens, cost ' + usd(r.costUsd) + '\n\n' + r.text
              : 'Not run (' + r.code + '). ' + (r.skipped || []).map(function (s) { return s.provider + ': ' + s.reason; }).concat((r.attempts || []).map(function (a) { return a.provider + ': ' + a.error; })).join('; ');
          } catch (error) { output.textContent = error.message; } finally { event.target.disabled = false; }
        } }),
        output
      ]));

      inner.replaceChildren.apply(inner, [status].concat(nodes));
    }

    try { await render(); } catch (error) { inner.replaceChildren(el('div', { class: 'notice error', text: error.message })); }
  }

  if (window.JarvisStudio && window.JarvisStudio.registerView) window.JarvisStudio.registerView('models', mount);
})();
