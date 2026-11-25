/*
 * JARVIS browser extension: page reader (E3:D4.21). Classic script: exposes self.JarvisExtract.
 *
 * Works against a minimal node interface (nodeType, tagName, childNodes, getAttribute, nodeValue), so the
 * same code runs on the live DOM (injected on demand into the active tab) and on fixture HTML in tests.
 *
 * Privacy rules enforced here:
 *  - input, textarea, select and contenteditable content is NEVER read; no code path touches a `value`.
 *    Password and payment-card fields are therefore never read (forms are described by name/label/type only).
 *  - script/style/template/iframe/svg and hidden elements are skipped.
 *  - output is size-capped; URLs are returned without query string or fragment.
 */
(function (root) {
  'use strict';

  var SKIP = { script: 1, style: 1, noscript: 1, template: 1, svg: 1, iframe: 1, object: 1, embed: 1, canvas: 1, head: 1,
    input: 1, textarea: 1, select: 1, option: 1, optgroup: 1, button: 1, datalist: 1, audio: 1, video: 1 };
  var BOILERPLATE = { nav: 1, aside: 1, footer: 1, form: 1 };
  var BLOCK = { p: 1, div: 1, section: 1, article: 1, li: 1, tr: 1, br: 1, h1: 1, h2: 1, h3: 1, h4: 1, h5: 1, h6: 1, ul: 1, ol: 1,
    table: 1, blockquote: 1, pre: 1, header: 1, footer: 1, main: 1, dt: 1, dd: 1, dl: 1, figcaption: 1, figure: 1, hr: 1, caption: 1 };
  var LIMITS = { text: 24000, headings: 60, links: 50, tables: 15, rows: 60, cols: 12, cell: 200, lists: 15, listItems: 30,
    keyValue: 60, jsonld: 10, jsonldBytes: 20000, microdata: 20, forms: 10, fields: 60, options: 20, label: 160 };

  function tag(node) { return node && node.nodeType === 1 ? String(node.tagName || '').toLowerCase() : ''; }
  function attr(node, name) {
    var v = node && node.getAttribute ? node.getAttribute(name) : null;
    return v === null || v === undefined ? '' : String(v);
  }
  function kids(node) { return node && node.childNodes ? Array.prototype.slice.call(node.childNodes) : []; }
  function clip(s, n) { s = String(s); return s.length > n ? s.slice(0, n) : s; }
  function squash(s) { return String(s).replace(/\s+/g, ' ').trim(); }

  function isHidden(el) {
    if (el.hasAttribute ? el.hasAttribute('hidden') : attr(el, 'hidden') !== '') return true;
    if (attr(el, 'aria-hidden').toLowerCase() === 'true') return true;
    var style = attr(el, 'style').toLowerCase().replace(/\s+/g, '');
    return style.indexOf('display:none') !== -1 || style.indexOf('visibility:hidden') !== -1;
  }
  function isEditable(el) {
    var ce = attr(el, 'contenteditable').toLowerCase();
    return ce === 'true' || ce === '';
  }
  function hasEditableAttr(el) { return el.hasAttribute ? el.hasAttribute('contenteditable') && isEditable(el) : attr(el, 'contenteditable') === 'true'; }

  /** True when the element (and everything under it) must not be read as page text. */
  function skipped(el, extraSkip) {
    var t = tag(el);
    if (SKIP[t]) return true;
    if (extraSkip && extraSkip[t]) return true;
    if (isHidden(el) || hasEditableAttr(el)) return true;
    var role = attr(el, 'role').toLowerCase();
    return extraSkip === BOILERPLATE && (role === 'navigation' || role === 'banner' || role === 'contentinfo' || role === 'complementary');
  }

  function textOf(node, extraSkip) {
    var out = [];
    (function walk(n) {
      if (n.nodeType === 3) { out.push(String(n.nodeValue || '')); return; }
      if (n.nodeType !== 1) return;
      if (skipped(n, extraSkip)) return;
      var t = tag(n), block = BLOCK[t];
      if (block) out.push('\n');
      kids(n).forEach(walk);
      if (block) out.push('\n');
      else if (t === 'td' || t === 'th') out.push(' ');
    })(node);
    return out.join('').replace(/[ \t\f\v ]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  }
  function inlineText(node) { return squash(textOf(node, null)); }
  /** Label of an <option>: its own text nodes. Option text is a choice label, not a typed value. */
  function optionLabel(node) { return squash(kids(node).map(function (c) { return c.nodeType === 3 ? String(c.nodeValue || '') : ''; }).join('')); }

  /** Single pass over the document: collects parents and the elements later steps need. */
  function scan(rootNode) {
    var info = { parent: new Map(), metas: [], links: [], titles: [], ldScripts: [], tables: [], forms: [], lists: [], dls: [], times: [],
      anchors: [], headings: [], labels: [], itemscopes: [], inputsOutsideForms: [], articles: [], mains: [], paragraphs: [], body: null };
    (function walk(n, parent) {
      if (n.nodeType !== 1) return;
      info.parent.set(n, parent);
      var t = tag(n);
      if (t === 'body' && !info.body) info.body = n;
      else if (t === 'meta') info.metas.push(n);
      else if (t === 'link') info.links.push(n);
      else if (t === 'title') info.titles.push(n);
      else if (t === 'script' && attr(n, 'type').toLowerCase().indexOf('ld+json') !== -1) info.ldScripts.push(n);
      else if (t === 'table') info.tables.push(n);
      else if (t === 'form') info.forms.push(n);
      else if (t === 'ul' || t === 'ol') info.lists.push(n);
      else if (t === 'dl') info.dls.push(n);
      else if (t === 'time') info.times.push(n);
      else if (t === 'a') info.anchors.push(n);
      else if (/^h[1-6]$/.test(t)) info.headings.push(n);
      else if (t === 'label') info.labels.push(n);
      else if (t === 'article') info.articles.push(n);
      else if (t === 'main' || attr(n, 'role').toLowerCase() === 'main') info.mains.push(n);
      else if (t === 'p' || t === 'pre' || t === 'blockquote') info.paragraphs.push(n);
      if (attr(n, 'itemscope') !== '' || (n.hasAttribute && n.hasAttribute('itemscope'))) info.itemscopes.push(n);
      kids(n).forEach(function (c) { walk(c, n); });
    })(rootNode, null);
    return info;
  }

  function ancestors(info, node) {
    var list = [], p = info.parent.get(node);
    while (p) { list.push(p); p = info.parent.get(p); }
    return list;
  }
  function insideTag(info, node, set) {
    return ancestors(info, node).some(function (a) { return set[tag(a)] || isHidden(a); });
  }

  // ---------- readable text (simple readability heuristic) ----------

  function linkDensity(node) {
    var total = inlineText(node).length;
    if (!total) return 1;
    var linked = 0;
    (function walk(n) {
      if (n.nodeType !== 1) return;
      if (tag(n) === 'a') { linked += inlineText(n).length; return; }
      kids(n).forEach(walk);
    })(node);
    return Math.min(1, linked / total);
  }

  function findMain(info, docRoot) {
    var best = null, bestLen = 0;
    var explicit = info.mains.concat(info.articles).filter(function (n) { return !isHidden(n); });
    explicit.forEach(function (n) {
      var len = textOf(n, BOILERPLATE).length;
      if (len > bestLen) { best = n; bestLen = len; }
    });
    if (best && bestLen >= 200) return best;
    // Score containers by the paragraphs they hold.
    var scores = new Map(), pick = null, pickScore = 0;
    info.paragraphs.forEach(function (p) {
      if (insideTag(info, p, BOILERPLATE)) return;
      var text = inlineText(p);
      if (text.length < 25) return;
      var score = (1 + (text.match(/[,;.]/g) || []).length + Math.min(Math.floor(text.length / 100), 3)) * (1 - linkDensity(p));
      var parent = info.parent.get(p), grand = parent ? info.parent.get(parent) : null;
      if (parent) scores.set(parent, (scores.get(parent) || 0) + score);
      if (grand) scores.set(grand, (scores.get(grand) || 0) + score / 2);
    });
    scores.forEach(function (score, node) {
      var adj = score * (1 - linkDensity(node) * 0.5);
      if (adj > pickScore) { pick = node; pickScore = adj; }
    });
    if (pick && tag(pick) !== 'html') return pick;
    return best || info.body || docRoot;
  }

  function capText(text, max) {
    if (text.length <= max) return { text: text, truncated: false };
    var cut = text.slice(0, max), lastBreak = Math.max(cut.lastIndexOf('\n'), cut.lastIndexOf('. '));
    return { text: (lastBreak > max * 0.6 ? cut.slice(0, lastBreak + 1) : cut).trim(), truncated: true };
  }

  // ---------- URLs ----------

  function cleanUrl(href, base) {
    try {
      var u = new URL(href, base || undefined);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
      return u.origin + u.pathname;
    } catch (e) { return ''; }
  }

  // ---------- metadata ----------

  function metaMap(info) {
    var m = {};
    info.metas.forEach(function (n) {
      var key = (attr(n, 'property') || attr(n, 'name') || attr(n, 'itemprop')).toLowerCase();
      var content = attr(n, 'content');
      if (key && content && !(key in m)) m[key] = clip(squash(content), 400);
    });
    return m;
  }

  function jsonldItems(info) {
    var items = [], bytes = 0;
    info.ldScripts.forEach(function (s) {
      var raw = kids(s).map(function (c) { return c.nodeValue || ''; }).join('').trim();
      if (!raw || raw.length > 200000) return;
      var parsed;
      try { parsed = JSON.parse(raw); } catch (e) { return; }
      var list = [];
      (function flat(v) {
        if (Array.isArray(v)) v.forEach(flat);
        else if (v && typeof v === 'object') { if (Array.isArray(v['@graph'])) flat(v['@graph']); else list.push(v); }
      })(parsed);
      list.forEach(function (item) {
        var size = JSON.stringify(item).length;
        if (items.length >= LIMITS.jsonld || bytes + size > LIMITS.jsonldBytes) return;
        bytes += size; items.push(item);
      });
    });
    return items;
  }

  function firstStr(v) {
    if (typeof v === 'string') return v;
    if (Array.isArray(v)) return firstStr(v[0]);
    if (v && typeof v === 'object') return firstStr(v.name || v['@value']);
    return '';
  }

  function pageMeta(info, ld, mainNode) {
    var m = metaMap(info);
    var meta = {};
    var title = info.titles.length ? inlineText(info.titles[0]) : '';
    meta.title = clip(m['og:title'] || title, 300);
    var canonical = '';
    info.links.forEach(function (n) { if (!canonical && attr(n, 'rel').toLowerCase().split(/\s+/).indexOf('canonical') !== -1) canonical = attr(n, 'href'); });
    if (canonical) meta.canonical = canonical;
    var desc = m['description'] || m['og:description'];
    if (desc) meta.description = desc;
    var og = {};
    ['og:type', 'og:url', 'og:site_name', 'og:image', 'og:locale'].forEach(function (k) { if (m[k]) og[k.slice(3)] = m[k]; });
    if (Object.keys(og).length) { meta.openGraph = og; if (og.site_name) meta.siteName = og.site_name; }
    var ldPublished = '', ldModified = '', ldAuthor = '';
    ld.forEach(function (item) {
      ldPublished = ldPublished || firstStr(item.datePublished);
      ldModified = ldModified || firstStr(item.dateModified);
      ldAuthor = ldAuthor || firstStr(item.author);
    });
    var timeEl = null;
    info.times.forEach(function (t) { if (!timeEl && attr(t, 'datetime') && (!mainNode || ancestors(info, t).indexOf(mainNode) !== -1)) timeEl = t; });
    var published = m['article:published_time'] || m['datepublished'] || m['date'] || m['pubdate'] || ldPublished || (timeEl ? attr(timeEl, 'datetime') : '');
    var modified = m['article:modified_time'] || m['og:updated_time'] || m['datemodified'] || m['last-modified'] || ldModified;
    var author = m['author'] || m['article:author'] || m['twitter:creator'] || ldAuthor;
    if (!author) info.anchors.forEach(function (a) { if (!author && attr(a, 'rel').toLowerCase().indexOf('author') !== -1) author = inlineText(a); });
    if (published) meta.published = clip(published, 60);
    if (modified) meta.modified = clip(modified, 60);
    if (author) meta.author = clip(author, 160);
    return meta;
  }

  // ---------- tables, lists, key-value ----------

  function directRows(table) {
    var rows = [];
    (function walk(n) {
      kids(n).forEach(function (c) {
        var t = tag(c);
        if (t === 'tr') rows.push(c);
        else if (t === 'thead' || t === 'tbody' || t === 'tfoot') walk(c);
      });
    })(table);
    return rows;
  }
  function rowCells(row) { return kids(row).filter(function (c) { var t = tag(c); return t === 'td' || t === 'th'; }); }

  function extractTables(info) {
    var out = [];
    info.tables.forEach(function (table) {
      if (out.length >= LIMITS.tables || isHidden(table) || ancestors(info, table).some(function (a) { return tag(a) === 'table'; })) return;
      var rows = directRows(table);
      if (rows.length < 2) return;
      var captionNode = kids(table).filter(function (c) { return tag(c) === 'caption'; })[0];
      var grid = rows.slice(0, LIMITS.rows + 1).map(function (r) {
        return rowCells(r).slice(0, LIMITS.cols).map(function (c) { return clip(inlineText(c), LIMITS.cell); });
      });
      var firstCells = rowCells(rows[0]);
      var headerRow = firstCells.length > 0 && firstCells.every(function (c) { return tag(c) === 'th'; });
      var headers = headerRow ? grid.shift() : [];
      if (!grid.length || Math.max.apply(null, grid.map(function (r) { return r.length; })) < 2) return;
      out.push({ caption: captionNode ? clip(inlineText(captionNode), 200) : '', headers: headers, rows: grid.slice(0, LIMITS.rows),
        truncated: rows.length > LIMITS.rows + 1 });
    });
    return out;
  }

  function extractLists(info, mainNode) {
    var out = [];
    info.lists.forEach(function (list) {
      if (out.length >= LIMITS.lists || isHidden(list) || insideTag(info, list, BOILERPLATE)) return;
      if (mainNode && ancestors(info, list).indexOf(mainNode) === -1 && list !== mainNode) return;
      if (ancestors(info, list).some(function (a) { var t = tag(a); return t === 'ul' || t === 'ol'; })) return;
      var items = kids(list).filter(function (c) { return tag(c) === 'li'; }).map(function (li) { return clip(inlineText(li), LIMITS.cell); }).filter(Boolean);
      var linkOnly = items.length && linkDensity(list) > 0.8;
      if (items.length < 3 || linkOnly) return;
      out.push({ ordered: tag(list) === 'ol', items: items.slice(0, LIMITS.listItems), truncated: items.length > LIMITS.listItems });
    });
    return out;
  }

  function extractKeyValue(info) {
    var out = [];
    function add(k, v) {
      k = clip(k.replace(/[:：]\s*$/, ''), 120); v = clip(v, LIMITS.cell);
      if (k && v && out.length < LIMITS.keyValue) out.push({ key: k, value: v });
    }
    info.dls.forEach(function (dl) {
      if (isHidden(dl)) return;
      var key = '';
      kids(dl).forEach(function (c) {
        var t = tag(c);
        if (t === 'dt') key = inlineText(c);
        else if (t === 'dd' && key) add(key, inlineText(c));
      });
    });
    info.tables.forEach(function (table) {
      if (isHidden(table)) return;
      var rows = directRows(table);
      if (rows.length < 2) return;
      var pairs = rows.map(rowCells);
      if (!pairs.every(function (cells) { return cells.length === 2; })) return;
      if (pairs.every(function (cells) { return tag(cells[0]) === 'th' && tag(cells[1]) === 'td'; })) {
        pairs.forEach(function (cells) { add(inlineText(cells[0]), inlineText(cells[1])); });
      }
    });
    return out;
  }

  // ---------- microdata ----------

  function itempropValue(el) {
    var t = tag(el);
    if (t === 'meta') return attr(el, 'content');
    if (t === 'a' || t === 'link' || t === 'area') return attr(el, 'href');
    if (t === 'img' || t === 'source') return attr(el, 'src');
    if (t === 'time') return attr(el, 'datetime') || inlineText(el);
    if (attr(el, 'content')) return attr(el, 'content');
    return inlineText(el);
  }
  function microdataOf(scope, depth) {
    var item = { type: attr(scope, 'itemtype') ? clip(attr(scope, 'itemtype'), 200) : '', properties: {} };
    (function walk(n) {
      kids(n).forEach(function (c) {
        if (c.nodeType !== 1 || isHidden(c)) return;
        var prop = attr(c, 'itemprop');
        var isScope = c.hasAttribute ? c.hasAttribute('itemscope') : attr(c, 'itemscope') !== '';
        if (prop) {
          var name = clip(prop.split(/\s+/)[0], 80);
          var value = isScope ? (depth < 3 ? microdataOf(c, depth + 1) : '') : clip(itempropValue(c), 300);
          if (value !== '' && !(name in item.properties)) item.properties[name] = value;
          if (!isScope) walk(c);
        } else if (!isScope) walk(c);
      });
    })(scope);
    return item;
  }
  function extractMicrodata(info) {
    var out = [];
    info.itemscopes.forEach(function (scope) {
      if (out.length >= LIMITS.microdata || isHidden(scope)) return;
      if (attr(scope, 'itemprop')) return; // nested scopes are reported inside their parent
      var item = microdataOf(scope, 1);
      if (Object.keys(item.properties).length) out.push(item);
    });
    return out;
  }

  // ---------- forms (descriptions only; never values) ----------

  var SENSITIVE_NAME = /pass(word|wd)?|pwd|card|cc-?num|cvv|cvc|ccv|security.?code|ssn|social.?security|iban|routing|account.?num|pin\b|otp|one.?time|tax.?id|passport|licen[sc]e/i;

  function fieldInfo(info, el, labelsFor) {
    var t = tag(el);
    var type = t === 'input' ? (attr(el, 'type').toLowerCase() || 'text') : t;
    if (type === 'hidden' || type === 'submit' || type === 'button' || type === 'image' || type === 'reset') return null;
    var id = attr(el, 'id'), name = attr(el, 'name');
    var label = '';
    if (id && labelsFor[id]) label = labelsFor[id];
    if (!label) {
      var anc = ancestors(info, el).filter(function (a) { return tag(a) === 'label'; })[0];
      if (anc) label = inlineText(anc);
    }
    if (!label) label = attr(el, 'aria-label');
    var autocomplete = attr(el, 'autocomplete').toLowerCase();
    var field = { tag: t, type: type, name: clip(name, 80), id: clip(id, 80), label: clip(squash(label), LIMITS.label),
      placeholder: clip(attr(el, 'placeholder'), LIMITS.label), required: el.hasAttribute ? el.hasAttribute('required') : attr(el, 'required') !== '',
      autocomplete: clip(autocomplete, 40) };
    field.sensitive = type === 'password' || /^cc-|one-time-code|new-password|current-password/.test(autocomplete) ||
      SENSITIVE_NAME.test(name + ' ' + id + ' ' + field.label);
    if (t === 'select') {
      field.options = kids(el).reduce(function (acc, o) {
        if (tag(o) === 'option') acc.push(clip(optionLabel(o), 80));
        else if (tag(o) === 'optgroup') kids(o).forEach(function (oo) { if (tag(oo) === 'option') acc.push(clip(optionLabel(oo), 80)); });
        return acc;
      }, []).slice(0, LIMITS.options);
    }
    if (!field.name) delete field.name;
    if (!field.id) delete field.id;
    if (!field.label) delete field.label;
    if (!field.placeholder) delete field.placeholder;
    if (!field.autocomplete) delete field.autocomplete;
    return field;
  }

  function guessPurpose(fields, buttons, text) {
    var types = fields.map(function (f) { return f.type; });
    var words = (text + ' ' + fields.map(function (f) { return (f.name || '') + ' ' + (f.label || '') + ' ' + (f.placeholder || ''); }).join(' ') + ' ' + buttons.join(' ')).toLowerCase();
    var passwords = types.filter(function (x) { return x === 'password'; }).length;
    if (fields.some(function (f) { return /^cc-/.test(f.autocomplete || '') || /card.?(number|num)|cvv|cvc/.test(((f.name || '') + ' ' + (f.label || '')).toLowerCase()); })) return 'payment';
    if (passwords >= 2 || (passwords === 1 && /sign.?up|register|create.*account|join/.test(words))) return 'signup';
    if (passwords === 1) return 'login';
    if (types.indexOf('search') !== -1 || /\b(search|query)\b/.test(words) && fields.length <= 2) return 'search';
    if (types.indexOf('email') !== -1 && fields.length <= 2 && /subscribe|newsletter|updates/.test(words)) return 'newsletter';
    if (types.indexOf('textarea') !== -1 && /message|contact|enquiry|inquiry|feedback|comment/.test(words)) return 'contact';
    if (/checkout|shipping|billing|address|order/.test(words)) return 'checkout';
    return 'other';
  }

  function extractForms(info) {
    var labelsFor = {};
    info.labels.forEach(function (l) { var f = attr(l, 'for'); if (f && !labelsFor[f]) labelsFor[f] = inlineText(l); });
    var out = [];
    info.forms.forEach(function (form) {
      if (out.length >= LIMITS.forms || isHidden(form)) return;
      var fields = [], buttons = [];
      (function walk(n) {
        kids(n).forEach(function (c) {
          if (c.nodeType !== 1) return;
          var t = tag(c);
          if (t === 'input' || t === 'textarea' || t === 'select') {
            var f = fieldInfo(info, c, labelsFor);
            if (f && fields.length < LIMITS.fields) fields.push(f);
            var it = attr(c, 'type').toLowerCase();
            if (t === 'input' && (it === 'submit' || it === 'button')) buttons.push(clip(attr(c, 'aria-label') || 'submit', 60));
          } else if (t === 'button') buttons.push(clip(inlineText(c) || attr(c, 'aria-label'), 60));
          else walk(c);
        });
      })(form);
      var heading = '';
      ancestors(info, form).slice(0, 3).forEach(function (a) { if (!heading) heading = (kids(a).filter(function (c) { return /^h[1-6]$/.test(tag(c)); }).map(inlineText)[0]) || ''; });
      var action = attr(form, 'action');
      out.push({ id: clip(attr(form, 'id') || attr(form, 'name'), 60), method: (attr(form, 'method') || 'get').toLowerCase(),
        action: clip(String(action).split('?')[0].split('#')[0], 200), heading: clip(heading, 160),
        fields: fields, buttons: buttons.filter(Boolean).slice(0, 6), purposeGuess: guessPurpose(fields, buttons, heading) });
    });
    return out;
  }

  // ---------- public API ----------

  /**
   * Extract a page. `doc` is a document-like object (documentElement / childNodes) or any element.
   * opts: { url, maxChars, selection, include: { structured: bool, forms: bool } }
   */
  function extractPage(doc, opts) {
    opts = opts || {};
    var include = opts.include || {};
    var docRoot = doc.documentElement || doc;
    var info = scan(docRoot);
    var main = findMain(info, docRoot);
    var capped = capText(textOf(main, BOILERPLATE), opts.maxChars || LIMITS.text);
    var ld = jsonldItems(info);
    var base = opts.url || '';
    var meta = pageMeta(info, ld, main);
    if (meta.canonical) meta.canonical = cleanUrl(meta.canonical, base);
    if (!meta.canonical) delete meta.canonical;
    var inMain = function (n) { return n === main || ancestors(info, n).indexOf(main) !== -1; };
    var headings = info.headings.filter(function (h) { return inMain(h) && !isHidden(h) && !insideTag(info, h, { nav: 1, aside: 1, footer: 1 }); })
      .map(function (h) { return { level: Number(tag(h).charAt(1)), text: clip(inlineText(h), 200) }; })
      .filter(function (h) { return h.text; }).slice(0, LIMITS.headings);
    var seen = {}, links = [];
    info.anchors.forEach(function (a) {
      if (links.length >= LIMITS.links || !inMain(a) || isHidden(a) || insideTag(info, a, { nav: 1, footer: 1, aside: 1 })) return;
      var href = cleanUrl(attr(a, 'href'), base), text = clip(inlineText(a), 120);
      if (!href || !text || seen[href]) return;
      seen[href] = true; links.push({ text: text, href: href });
    });
    var title = meta.title || '';
    var result = {
      url: cleanUrl(base, undefined) || base, title: title, meta: meta, headings: headings, text: capped.text, textLength: capped.text.length,
      truncated: capped.truncated, links: links
    };
    if (opts.selection) result.selection = clip(String(opts.selection), 6000);
    if (include.structured) {
      result.jsonld = ld; result.microdata = extractMicrodata(info); result.tables = extractTables(info);
      result.lists = extractLists(info, main); result.keyValue = extractKeyValue(info);
    }
    if (include.forms) result.forms = extractForms(info);
    return result;
  }

  root.JarvisExtract = { extractPage: extractPage, textOf: textOf, LIMITS: LIMITS };
})(typeof self !== 'undefined' ? self : globalThis);
