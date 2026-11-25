/**
 * Minimal HTML parser for tests (E3:D4.21): builds a DOM-like tree (nodeType, tagName, childNodes,
 * getAttribute, hasAttribute, nodeValue) that the extension's page reader accepts. Test helper only.
 */
export interface MiniNode {
  nodeType: 1 | 3;
  tagName?: string;
  nodeValue?: string;
  childNodes: MiniNode[];
  attrs: Record<string, string>;
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
}

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const RAW = new Set(['script', 'style']);
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decode = (s: string) => s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
  if (e[0] === '#') return String.fromCodePoint(e[1]!.toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
  return ENTITIES[e.toLowerCase()] ?? m;
});

function element(tagName: string, attrs: Record<string, string>): MiniNode {
  return {
    nodeType: 1, tagName: tagName.toUpperCase(), childNodes: [], attrs,
    getAttribute(name) { return name.toLowerCase() in attrs ? attrs[name.toLowerCase()]! : null; },
    hasAttribute(name) { return name.toLowerCase() in attrs; },
  };
}
const text = (value: string): MiniNode => ({ nodeType: 3, nodeValue: value, childNodes: [], attrs: {}, getAttribute: () => null, hasAttribute: () => false });

export function parseHtml(html: string): { documentElement: MiniNode } {
  const root = element('html', {});
  const stack: MiniNode[] = [root];
  const top = () => stack[stack.length - 1]!;
  const re = /<!--[\s\S]*?-->|<!doctype[^>]*>|<\/([a-z0-9-]+)\s*>|<([a-z][a-z0-9-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>|([^<]+|<)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    if (m[1]) {
      const name = m[1].toUpperCase();
      for (let i = stack.length - 1; i > 0; i -= 1) {
        if (stack[i]!.tagName === name) { stack.length = i; break; }
      }
    } else if (m[2]) {
      const name = m[2].toLowerCase();
      if (name === 'html') continue;
      const attrs: Record<string, string> = {};
      for (const a of (m[3] ?? '').matchAll(/([^\s=>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
        attrs[a[1]!.toLowerCase()] = decode(a[2] ?? a[3] ?? a[4] ?? '');
      }
      // Auto-close implied elements a tolerant parser would close.
      if (name === 'li' && top().tagName === 'LI') stack.pop();
      if ((name === 'dt' || name === 'dd') && (top().tagName === 'DT' || top().tagName === 'DD')) stack.pop();
      if (name === 'tr' && top().tagName === 'TR') stack.pop();
      if ((name === 'td' || name === 'th') && (top().tagName === 'TD' || top().tagName === 'TH')) stack.pop();
      if (name === 'p' && top().tagName === 'P') stack.pop();
      const node = element(name, attrs);
      top().childNodes.push(node);
      if (RAW.has(name) && !m[4]) {
        const end = html.toLowerCase().indexOf(`</${name}`, re.lastIndex);
        const stop = end < 0 ? html.length : end;
        if (stop > re.lastIndex) node.childNodes.push(text(html.slice(re.lastIndex, stop)));
        re.lastIndex = stop;
      } else if (!VOID.has(name) && !m[4]) stack.push(node);
    } else if (m[5]) {
      top().childNodes.push(text(decode(m[5])));
    }
  }
  return { documentElement: root };
}
