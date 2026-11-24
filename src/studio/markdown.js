// JARVIS Studio: safe text helpers shared by the browser UI and the tests.
// Model output is never turned into HTML strings. parseMarkdown() returns a plain
// data tree; the UI builds DOM nodes from it with createElement/textContent only.

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' };

/** Escape text for use inside HTML. Non-strings become an empty string. */
export function escapeHtml(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/[&<>"'`]/g, (char) => HTML_ESCAPES[char]);
}

/** Only http(s) and mailto links are ever made clickable. */
export function safeUrl(raw) {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (!value || value.length > 2048 || /[\u0000-\u001f\u007f\s]/.test(value)) return null;
  try {
    const url = new URL(value);
    return ['http:', 'https:', 'mailto:'].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

const INLINE_SOURCE = /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)|\*\*([^*\n][\s\S]*?)\*\*|__([^_\n][\s\S]*?)__|\*([^*\s][^*\n]*?)\*|(?<![A-Za-z0-9_])_([^_\s][^_\n]*?)_(?![A-Za-z0-9_])|\[([^\]\n]+)\]\(([^)\s]+)\)/g;

/** Inline markdown to nodes: text, code, strong, em, link. */
export function parseInline(text) {
  const nodes = [];
  let last = 0;
  const source = String(text ?? '');
  // A fresh regex per call: the recursive calls below must not share lastIndex.
  const INLINE = new RegExp(INLINE_SOURCE.source, 'g');
  let match;
  while ((match = INLINE.exec(source)) !== null) {
    if (match.index > last) nodes.push({ type: 'text', value: source.slice(last, match.index) });
    if (match[1] !== undefined) nodes.push({ type: 'code', value: match[2].trim() });
    else if (match[3] !== undefined || match[4] !== undefined) nodes.push({ type: 'strong', children: parseInline(match[3] ?? match[4]) });
    else if (match[5] !== undefined || match[6] !== undefined) nodes.push({ type: 'em', children: parseInline(match[5] ?? match[6]) });
    else {
      const href = safeUrl(match[8]);
      if (href) nodes.push({ type: 'link', href, children: parseInline(match[7]) });
      else nodes.push({ type: 'text', value: match[0] });
    }
    last = match.index + match[0].length;
  }
  if (last < source.length) nodes.push({ type: 'text', value: source.slice(last) });
  return nodes;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([A-Za-z0-9_+#.-]*)[^\n]*$/;
const HR = /^ {0,3}([-*_])( *\1){2,}\s*$/;
const LIST_ITEM = /^ {0,3}([-*+]|\d{1,9}[.)])\s+(.*)$/;

/** Block markdown to a tree: p, h(level), ul, ol, quote, hr, code(lang). */
export function parseMarkdown(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let index = 0;
  const startsBlock = (line) => FENCE.test(line) || /^ {0,3}#{1,6}\s/.test(line) || LIST_ITEM.test(line) || /^ {0,3}>/.test(line) || HR.test(line);
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) { index += 1; continue; }
    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1];
      const body = [];
      index += 1;
      // An unterminated fence (a reply still streaming) runs to the end of the text.
      while (index < lines.length && !(lines[index].trim().startsWith(marker) && lines[index].trim().replace(/[`~]/g, '') === '')) {
        body.push(lines[index]);
        index += 1;
      }
      index += 1;
      blocks.push({ type: 'code', lang: fence[2].slice(0, 32), value: body.join('\n') });
      continue;
    }
    const heading = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) { blocks.push({ type: 'h', level: heading[1].length, children: parseInline(heading[2]) }); index += 1; continue; }
    if (HR.test(line)) { blocks.push({ type: 'hr' }); index += 1; continue; }
    if (/^ {0,3}>/.test(line)) {
      const quoted = [];
      while (index < lines.length && /^ {0,3}>/.test(lines[index])) { quoted.push(lines[index].replace(/^ {0,3}> ?/, '')); index += 1; }
      blocks.push({ type: 'quote', children: parseMarkdown(quoted.join('\n')) });
      continue;
    }
    const first = LIST_ITEM.exec(line);
    if (first) {
      const ordered = /\d/.test(first[1]);
      const items = [];
      while (index < lines.length) {
        const item = LIST_ITEM.exec(lines[index]);
        if (!item || /\d/.test(item[1]) !== ordered) break;
        items.push(parseInline(item[2]));
        index += 1;
      }
      blocks.push({ type: ordered ? 'ol' : 'ul', items });
      continue;
    }
    const paragraph = [line.trim()];
    index += 1;
    while (index < lines.length && lines[index].trim() && !startsBlock(lines[index])) { paragraph.push(lines[index].trim()); index += 1; }
    blocks.push({ type: 'p', children: parseInline(paragraph.join('\n')) });
  }
  return blocks;
}
