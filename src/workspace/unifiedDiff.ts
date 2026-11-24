/**
 * Dependency-free unified diff generation and application for workspace edits.
 * The applier is strict about content (context and removed lines must match the file) but
 * tolerant about line numbers and hunk-header counts, because model-written diffs often get
 * those wrong. A mismatch throws; nothing is ever guessed.
 */

export interface DiffHunk { oldStart: number; lines: string[] }
export interface FileDiff { oldPath: string | null; newPath: string | null; hunks: DiffHunk[] }

const MAX_DP_CELLS = 4_000_000;

export function splitLines(text: string): { lines: string[]; eol: '\n' | '\r\n'; finalNewline: boolean } {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const normalized = text.replace(/\r\n/g, '\n');
  if (normalized === '') return { lines: [], eol, finalNewline: false };
  const finalNewline = normalized.endsWith('\n');
  const lines = normalized.split('\n');
  if (finalNewline) lines.pop();
  return { lines, eol, finalNewline };
}

export function joinLines(lines: string[], eol: string, finalNewline: boolean): string {
  if (!lines.length) return '';
  return lines.join(eol) + (finalNewline ? eol : '');
}

interface Op { t: ' ' | '-' | '+'; s: string }

function diffOps(a: string[], b: string[]): Op[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const ops: Op[] = a.slice(0, start).map((s) => ({ t: ' ' as const, s }));
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const n = midA.length;
  const m = midB.length;
  if (n * m > MAX_DP_CELLS || n === 0 || m === 0) {
    for (const s of midA) ops.push({ t: '-', s });
    for (const s of midB) ops.push({ t: '+', s });
  } else {
    const width = m + 1;
    const table = new Uint32Array((n + 1) * width);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        table[i * width + j] = midA[i] === midB[j]
          ? table[(i + 1) * width + j + 1]! + 1
          : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (midA[i] === midB[j]) { ops.push({ t: ' ', s: midA[i]! }); i++; j++; }
      else if (table[(i + 1) * width + j]! >= table[i * width + j + 1]!) ops.push({ t: '-', s: midA[i++]! });
      else ops.push({ t: '+', s: midB[j++]! });
    }
    while (i < n) ops.push({ t: '-', s: midA[i++]! });
    while (j < m) ops.push({ t: '+', s: midB[j++]! });
  }
  for (const s of a.slice(endA)) ops.push({ t: ' ', s });
  return ops;
}

/** Unified diff of one file. `oldText === null` means a new file. Returns '' when nothing changed. */
export function createUnifiedDiff(path: string, oldText: string | null, newText: string, context = 3): string {
  const a = splitLines(oldText ?? '');
  const b = splitLines(newText);
  const ops = diffOps(a.lines, b.lines);
  const changed: number[] = [];
  ops.forEach((op, index) => { if (op.t !== ' ') changed.push(index); });
  const header = [oldText === null ? '--- /dev/null' : `--- a/${path}`, `+++ b/${path}`];
  if (!changed.length) {
    if (oldText === null) return header.join('\n') + '\n';
    // Only a trailing-newline change.
    if (a.lines.length && a.finalNewline !== b.finalNewline) {
      const last = a.lines.length;
      const out = [...header, `@@ -${last} +${last} @@`, `-${a.lines[last - 1]}`];
      if (!a.finalNewline) out.push('\\ No newline at end of file');
      out.push(`+${a.lines[last - 1]}`);
      if (!b.finalNewline) out.push('\\ No newline at end of file');
      return out.join('\n') + '\n';
    }
    return '';
  }
  const out = [...header];
  const groups: Array<[number, number]> = [];
  for (const index of changed) {
    const last = groups[groups.length - 1];
    if (last && index - last[1] <= context * 2) last[1] = index;
    else groups.push([index, index]);
  }
  const oldBefore: number[] = [];
  const newBefore: number[] = [];
  let oldCount = 0;
  let newCount = 0;
  for (const op of ops) {
    oldBefore.push(oldCount);
    newBefore.push(newCount);
    if (op.t !== '+') oldCount++;
    if (op.t !== '-') newCount++;
  }
  for (const [first, last] of groups) {
    const from = Math.max(0, first - context);
    const to = Math.min(ops.length - 1, last + context);
    const slice = ops.slice(from, to + 1);
    const oldLen = slice.filter((op) => op.t !== '+').length;
    const newLen = slice.filter((op) => op.t !== '-').length;
    const oldStart = oldLen === 0 ? oldBefore[from]! : oldBefore[from]! + 1;
    const newStart = newLen === 0 ? newBefore[from]! : newBefore[from]! + 1;
    out.push(`@@ -${oldStart}${oldLen === 1 ? '' : ',' + oldLen} +${newStart}${newLen === 1 ? '' : ',' + newLen} @@`);
    const touchesEnd = to === ops.length - 1;
    slice.forEach((op, k) => {
      out.push(op.t + op.s);
      if (touchesEnd && k === slice.length - 1) {
        // Mark a missing final newline on whichever side the last line belongs to.
        if (op.t !== '+' && !a.finalNewline && a.lines.length) out.push('\\ No newline at end of file');
        else if (op.t === '+' && !b.finalNewline) out.push('\\ No newline at end of file');
      }
    });
  }
  return out.join('\n') + '\n';
}

function cleanPath(raw: string): string | null {
  const text = raw.split('\t')[0]!.trim().replace(/^"|"$/g, '');
  if (text === '/dev/null') return null;
  return text.replace(/^[ab]\//, '');
}

export function parseUnifiedDiff(diff: string): FileDiff[] {
  const lines = diff.replace(/\r\n/g, '\n').split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  const files: FileDiff[] = [];
  let file: FileDiff | null = null;
  let hunk: DiffHunk | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const startsFile = line.startsWith('--- ') && lines[i + 1]?.startsWith('+++ ') && (lines[i + 2]?.startsWith('@@') ?? false);
    if (startsFile) {
      file = { oldPath: cleanPath(line.slice(4)), newPath: cleanPath(lines[i + 1]!.slice(4)), hunks: [] };
      files.push(file);
      hunk = null;
      i++;
      continue;
    }
    if (!file) continue;
    const header = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(line);
    if (header) {
      hunk = { oldStart: Number(header[1]), lines: [] };
      file.hunks.push(hunk);
    } else if (hunk && (line[0] === ' ' || line[0] === '+' || line[0] === '-' || line[0] === '\\')) {
      hunk.lines.push(line);
    } else if (hunk && line === '') {
      hunk.lines.push(' ');
    }
  }
  return files;
}

/** Apply the hunks of one file diff to `oldText` (null for a new file). Throws when content does not match. */
export function applyFileDiff(oldText: string | null, file: FileDiff): string {
  const source = splitLines(oldText ?? '');
  let lines = [...source.lines];
  let finalNewline = oldText === null ? true : source.finalNewline;
  let offset = 0;
  if (!file.hunks.length) throw new Error('The diff has no hunks.');
  for (const hunk of file.hunks) {
    const before: string[] = [];
    const after: string[] = [];
    let noNewlineAtEnd = false;
    hunk.lines.forEach((entry, k) => {
      if (entry.startsWith('\\')) {
        if (hunk.lines[k - 1]?.[0] !== '-') noNewlineAtEnd = true;
        return;
      }
      const body = entry.slice(1);
      if (entry[0] !== '+') before.push(body);
      if (entry[0] !== '-') after.push(body);
    });
    let at: number;
    if (before.length === 0) {
      at = oldText === null ? 0 : Math.min(Math.max(hunk.oldStart + offset, 0), lines.length);
    } else {
      const hint = hunk.oldStart - 1 + offset;
      const candidates: number[] = [];
      for (let start = 0; start + before.length <= lines.length; start++) {
        let match = true;
        for (let k = 0; k < before.length; k++) {
          if (lines[start + k] !== before[k]) { match = false; break; }
        }
        if (match) candidates.push(start);
      }
      if (!candidates.length) throw new Error('A hunk does not match the current file content (the file changed or the diff is wrong).');
      candidates.sort((x, y) => Math.abs(x - hint) - Math.abs(y - hint));
      at = candidates[0]!;
    }
    lines = [...lines.slice(0, at), ...after, ...lines.slice(at + before.length)];
    offset += after.length - before.length;
    if (at + after.length === lines.length) finalNewline = !noNewlineAtEnd;
  }
  return joinLines(lines, source.eol, finalNewline);
}
