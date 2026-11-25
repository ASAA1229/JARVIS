import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import type { Episode } from '../episodes';
import { claudeCodeParser } from './claudeCode';
import type { TranscriptParser } from './types';

/** Registered parsers. Add another assistant's parser here; unknown formats are skipped. */
export const PARSERS: ReadonlyArray<TranscriptParser<any>> = [claudeCodeParser];

/** Unrecognised lines tolerated before a file without any known record is skipped as an unknown format. */
const PROBE_LINES = 50;

export interface FileCursor {
  /** Byte offset to resume from: start of the open episode, else end of the last consumed line. */
  offset: number;
  parser?: string;
  /** True when no registered parser understood the file. */
  unknown?: boolean;
}

export interface TailResult { episodes: Episode[]; cursor: FileCursor; size: number }

/**
 * Incrementally read a transcript. State is rebuilt each poll from `cursor.offset`: because the cursor sits at the
 * start of the still-open episode, nothing needs to persist between polls or restarts. Episode ids are
 * deterministic, so a re-read never creates duplicates on the JARVIS side.
 */
export function tailTranscript(path: string, cursor: FileCursor, options: { idle: boolean; parsers?: ReadonlyArray<TranscriptParser<any>> }): TailResult {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    // An earlier "unknown" verdict is not final: new lines are re-checked (the offset has already moved past what was seen).
    if (cursor.unknown) cursor = { offset: cursor.offset };
    if (size < cursor.offset) cursor = { ...cursor, offset: 0 }; // file was truncated or replaced
    if (size === cursor.offset) return { episodes: [], cursor, size };
    const buffer = Buffer.alloc(size - cursor.offset);
    readSync(fd, buffer, 0, buffer.length, cursor.offset);

    const parsers = options.parsers ?? PARSERS;
    let parser = parsers.find((p) => p.id === cursor.parser);
    const episodes: Episode[] = [];
    let state: unknown;
    let consumed = 0;
    let position = 0;
    let probed = 0;
    while (position < buffer.length) {
      const newline = buffer.indexOf(0x0a, position);
      if (newline < 0) break; // partial last line: wait for the writer to finish it
      const line = buffer.subarray(position, newline).toString('utf8').replace(/\r$/, '');
      const lineOffset = cursor.offset + position;
      position = newline + 1;
      consumed = position;
      if (!line.trim()) continue;
      if (!parser) {
        // Decide on the first recognisable line, not the first line: a transcript may start (or resume) at a record
        // no parser knows. Only when nothing within the probe window is recognised is the file treated as unknown.
        parser = parsers.find((p) => p.accepts(line));
        if (!parser) {
          probed += 1;
          if (probed >= PROBE_LINES) return { episodes: [], cursor: { offset: cursor.offset + consumed, unknown: true }, size };
          continue;
        }
        state = parser.newState();
      }
      if (state === undefined) state = parser.newState();
      episodes.push(...parser.feedLine(state, line, lineOffset));
    }
    if (!parser) return { episodes, cursor: { offset: cursor.offset + consumed, ...(probed ? { unknown: true } : {}) }, size };
    if (options.idle && state !== undefined) episodes.push(...parser.flush(state));
    const openStart = state !== undefined ? parser.openStart(state) : undefined;
    return { episodes, cursor: { offset: openStart ?? cursor.offset + consumed, parser: parser.id }, size };
  } finally {
    closeSync(fd);
  }
}
