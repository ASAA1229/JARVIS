export type InlineNode =
  | { type: 'text'; value: string }
  | { type: 'code'; value: string }
  | { type: 'strong' | 'em'; children: InlineNode[] }
  | { type: 'link'; href: string; children: InlineNode[] };
export type BlockNode =
  | { type: 'p'; children: InlineNode[] }
  | { type: 'h'; level: number; children: InlineNode[] }
  | { type: 'ul' | 'ol'; items: InlineNode[][] }
  | { type: 'quote'; children: BlockNode[] }
  | { type: 'hr' }
  | { type: 'code'; lang: string; value: string };
export function escapeHtml(value: unknown): string;
export function safeUrl(raw: unknown): string | null;
export function parseInline(text: string): InlineNode[];
export function parseMarkdown(text: string): BlockNode[];
