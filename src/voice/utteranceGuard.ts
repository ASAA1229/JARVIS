/**
 * Software-level voice reliability controls (JARVIS-GAP-006).
 *
 * VoiceUtteranceGuard suppresses duplicate final transcripts so a single spoken
 * utterance can start at most one task. WakeMetrics keeps privacy-preserving
 * counters (no transcripts, no audio) for wake false-accept / false-reject
 * measurement. Neither class has any execution authority.
 *
 * Physical-microphone false-accept/false-reject rates still require measurement
 * on real hardware; these counters are the instrumentation that records them.
 */

export type UtteranceClaim =
  | { accepted: true }
  | { accepted: false; reason: 'duplicate_utterance' | 'duplicate_transcript'; taskId?: string };

interface UtteranceEntry {
  at: number;
  normalized: string;
  taskId?: string;
}

const ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

export function isValidUtteranceId(value: unknown): value is string {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

function normalizeTranscript(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
}

export class VoiceUtteranceGuard {
  private readonly byId = new Map<string, UtteranceEntry>();
  private readonly byText = new Map<string, UtteranceEntry>();

  constructor(
    private readonly windowMs = 5_000,
    private readonly idRetentionMs = 10 * 60_000,
    private readonly maxEntries = 500,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /**
   * Claims one utterance. The same utterance id is never accepted twice within the
   * retention window; identical normalized text from the same device inside the short
   * duplicate window (browser recognizers re-emit the final result) is also suppressed.
   */
  claim(deviceId: string, utteranceId: string, transcript: string): UtteranceClaim {
    if (!isValidUtteranceId(utteranceId)) throw new Error('utteranceId must be 8-64 URL-safe characters.');
    const now = this.now();
    this.prune(now);
    const idKey = `${deviceId}\u0000${utteranceId}`;
    const existing = this.byId.get(idKey);
    if (existing) return { accepted: false, reason: 'duplicate_utterance', taskId: existing.taskId };
    const normalized = normalizeTranscript(transcript);
    const textKey = `${deviceId}\u0000${normalized}`;
    const recent = normalized ? this.byText.get(textKey) : undefined;
    if (recent && now - recent.at < this.windowMs) {
      // Remember the duplicate id too, so late re-deliveries of it stay suppressed.
      this.byId.set(idKey, { at: now, normalized, taskId: recent.taskId });
      return { accepted: false, reason: 'duplicate_transcript', taskId: recent.taskId };
    }
    const entry: UtteranceEntry = { at: now, normalized };
    this.byId.set(idKey, entry);
    if (normalized) this.byText.set(textKey, entry);
    this.enforceBound();
    return { accepted: true };
  }

  /** Associates the accepted utterance with the one task it created. */
  bindTask(deviceId: string, utteranceId: string, taskId: string): void {
    const entry = this.byId.get(`${deviceId}\u0000${utteranceId}`);
    if (entry && !entry.taskId) entry.taskId = taskId;
  }

  size(): number {
    return this.byId.size;
  }

  private prune(now: number): void {
    for (const [key, entry] of this.byId) if (now - entry.at > this.idRetentionMs) this.byId.delete(key);
    for (const [key, entry] of this.byText) if (now - entry.at > this.windowMs) this.byText.delete(key);
    this.enforceBound();
  }

  private enforceBound(): void {
    while (this.byId.size > this.maxEntries) {
      const oldest = this.byId.keys().next().value;
      if (oldest === undefined) break;
      this.byId.delete(oldest);
    }
  }
}

export const WAKE_EVENTS = [
  'wake_detected',        // wake detector fired and capture started
  'command_dispatched',   // a post-wake transcript produced a task
  'duplicate_suppressed', // duplicate final transcript/utterance was dropped
  'no_speech_timeout',    // wake fired but no command followed
  'false_accept',         // owner marked: wake fired without intent
  'false_reject',         // owner marked: spoke the wake word but it did not fire
] as const;
export type WakeEvent = (typeof WAKE_EVENTS)[number];

export interface WakeMetricsSnapshot {
  counts: Record<WakeEvent, number>;
  falseAcceptRate: number | null;
  falseRejectRate: number | null;
  duplicateSuppressionRate: number | null;
  startedAt: number;
}

export class WakeMetrics {
  private readonly counts = Object.fromEntries(WAKE_EVENTS.map((event) => [event, 0])) as Record<WakeEvent, number>;
  private readonly startedAt: number;
  constructor(now: () => number = () => Date.now()) { this.startedAt = now(); }

  static isWakeEvent(value: unknown): value is WakeEvent {
    return typeof value === 'string' && (WAKE_EVENTS as readonly string[]).includes(value);
  }

  record(event: WakeEvent): void {
    if (!WakeMetrics.isWakeEvent(event)) throw new Error('Unknown wake event.');
    this.counts[event] += 1;
  }

  snapshot(): WakeMetricsSnapshot {
    const c = this.counts;
    const trueWakes = Math.max(0, c.wake_detected - c.false_accept);
    const ratio = (n: number, d: number) => (d > 0 ? n / d : null);
    return {
      counts: { ...c },
      // Fraction of wake firings the owner judged unintended.
      falseAcceptRate: ratio(c.false_accept, c.wake_detected),
      // Fraction of intended wake attempts that did not fire.
      falseRejectRate: ratio(c.false_reject, trueWakes + c.false_reject),
      duplicateSuppressionRate: ratio(c.duplicate_suppressed, c.command_dispatched + c.duplicate_suppressed),
      startedAt: this.startedAt,
    };
  }
}
