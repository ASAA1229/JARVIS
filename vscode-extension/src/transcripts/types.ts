import type { Episode } from '../episodes';

/**
 * Pluggable transcript parser. Another assistant's local log format is supported by adding a parser here
 * and registering it in PARSERS (transcripts/index.ts). Unknown formats are skipped, never guessed.
 */
export interface TranscriptParser<S = unknown> {
  readonly id: string;
  /** Cheap sniff of the first non-empty line of a file. */
  accepts(firstLine: string): boolean;
  newState(): S;
  /** Feed one complete line with the byte offset where it starts. Returns episodes closed by this line. */
  feedLine(state: S, line: string, offset: number): Episode[];
  /** Close any open episode (used when the transcript has gone idle). */
  flush(state: S): Episode[];
  /** Byte offset of the first line of the still-open episode, if any. */
  openStart(state: S): number | undefined;
}
