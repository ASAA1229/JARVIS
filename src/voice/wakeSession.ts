/**
 * Per-device wake / voice-command state machine (D2.3, D2.4).
 *
 * The wake detector itself (local ONNX in the HUD, or a transcript phrase matcher) only
 * decides "wake phrase heard". This machine owns what happens next and is the single
 * authority for the legal order of events, so a stray, replayed or out-of-order event
 * can never produce a command:
 *
 *   idle -> awaiting_command -> processing -> cooldown -> idle
 *
 * - A command is only accepted while awaiting_command (after a wake), inside a bounded window.
 * - A wake with no command inside the window expires back to idle (no_speech_timeout).
 * - Muting forces idle and refuses new wakes; a wake never authorizes execution by itself:
 *   the returned command text still goes through the planner and Policy Gateway.
 * - State is per device and never shared, so one device's wake cannot arm another.
 * - Only counters are recorded (WakeMetrics): never audio or transcript text.
 */
import { TranscriptWakePhrase } from './providers.js';
import { WakeMetrics, type WakeEvent } from './utteranceGuard.js';

export const WAKE_PHRASE = 'hey jarvis';
export const WAKE_ACKNOWLEDGEMENT = 'Hi sir, I am ready to work.';

export type WakeSessionState = 'idle' | 'awaiting_command' | 'processing' | 'cooldown';

export interface WakeSessionOptions {
  /** Time allowed for a command after the wake acknowledgement. */
  commandWindowMs?: number;
  /** Minimum quiet period after a command so the assistant's own speech cannot re-wake it. */
  cooldownMs?: number;
  /** Upper bound on one command's processing before the session self-recovers. */
  processingTimeoutMs?: number;
  now?: () => number;
  metrics?: WakeMetrics;
  matcher?: { match(transcript: string): string | undefined };
}

export type WakeOutcome =
  | { ok: true; state: WakeSessionState; acknowledgement?: string; command?: string }
  | { ok: false; state: WakeSessionState; reason: 'muted' | 'cooldown' | 'busy' | 'empty_command' | 'no_wake_phrase' };

interface Entry { state: WakeSessionState; until: number; muted: boolean }

export class WakeSessionMachine {
  private readonly entries = new Map<string, Entry>();
  private readonly commandWindowMs: number;
  private readonly cooldownMs: number;
  private readonly processingTimeoutMs: number;
  private readonly now: () => number;
  private readonly metrics: WakeMetrics;
  private readonly matcher: { match(transcript: string): string | undefined };

  constructor(options: WakeSessionOptions = {}) {
    this.commandWindowMs = options.commandWindowMs ?? 8_000;
    this.cooldownMs = options.cooldownMs ?? 1_500;
    this.processingTimeoutMs = options.processingTimeoutMs ?? 60_000;
    this.now = options.now ?? (() => Date.now());
    this.metrics = options.metrics ?? new WakeMetrics(this.now);
    this.matcher = options.matcher ?? new TranscriptWakePhrase(WAKE_PHRASE);
  }

  /** Current state after applying any elapsed timeouts. */
  state(deviceId: string): WakeSessionState {
    return this.expire(deviceId).state;
  }

  /** The wake detector fired. Arms exactly one command window for this device. */
  wake(deviceId: string): WakeOutcome {
    const entry = this.expire(deviceId);
    if (entry.muted) return { ok: false, state: entry.state, reason: 'muted' };
    if (entry.state === 'cooldown') return { ok: false, state: entry.state, reason: 'cooldown' };
    if (entry.state === 'processing') return { ok: false, state: entry.state, reason: 'busy' };
    if (entry.state === 'idle') this.record('wake_detected');
    entry.state = 'awaiting_command';
    entry.until = this.now() + this.commandWindowMs;
    return { ok: true, state: entry.state, acknowledgement: WAKE_ACKNOWLEDGEMENT };
  }

  /**
   * Handles a final transcript. If the phrase is present in the transcript itself
   * ("hey jarvis open notepad") it wakes and carries the command in one step; otherwise the
   * transcript is the command only if the device is awaiting one.
   */
  transcript(deviceId: string, transcript: string): WakeOutcome {
    const entry = this.expire(deviceId);
    if (entry.muted) return { ok: false, state: entry.state, reason: 'muted' };
    const inline = this.matcher.match(transcript);
    if (inline !== undefined) {
      if (entry.state === 'cooldown') return { ok: false, state: entry.state, reason: 'cooldown' };
      if (entry.state === 'processing') return { ok: false, state: entry.state, reason: 'busy' };
      if (entry.state === 'idle') this.record('wake_detected');
      if (!inline) {
        entry.state = 'awaiting_command';
        entry.until = this.now() + this.commandWindowMs;
        return { ok: true, state: entry.state, acknowledgement: WAKE_ACKNOWLEDGEMENT };
      }
      return this.beginProcessing(entry, inline);
    }
    if (entry.state !== 'awaiting_command') {
      const reason = entry.state === 'idle' ? 'no_wake_phrase' : entry.state === 'processing' ? 'busy' : 'cooldown';
      return { ok: false, state: entry.state, reason };
    }
    const command = transcript.trim();
    if (!command) return { ok: false, state: entry.state, reason: 'empty_command' };
    return this.beginProcessing(entry, command);
  }

  /** The dispatched command finished (success, failure or cancel): enter the post-command cooldown. */
  complete(deviceId: string): WakeSessionState {
    const entry = this.expire(deviceId);
    if (entry.state === 'processing') {
      entry.state = 'cooldown';
      entry.until = this.now() + this.cooldownMs;
    }
    return entry.state;
  }

  /** Explicit cancel (stop word, UI cancel): always returns to idle immediately. */
  cancel(deviceId: string): WakeSessionState {
    const entry = this.entry(deviceId);
    entry.state = 'idle';
    entry.until = 0;
    return entry.state;
  }

  /** Hard privacy mute for one device. Muting cancels any armed or in-flight window. */
  setMuted(deviceId: string, muted: boolean): WakeSessionState {
    const entry = this.entry(deviceId);
    entry.muted = muted;
    if (muted) { entry.state = 'idle'; entry.until = 0; }
    return entry.state;
  }

  /** Drop all state for a device (revocation / session end). */
  forget(deviceId: string): void {
    this.entries.delete(deviceId);
  }

  metricsSnapshot(): ReturnType<WakeMetrics['snapshot']> {
    return this.metrics.snapshot();
  }

  private beginProcessing(entry: Entry, command: string): WakeOutcome {
    entry.state = 'processing';
    entry.until = this.now() + this.processingTimeoutMs;
    this.record('command_dispatched');
    return { ok: true, state: entry.state, command };
  }

  private entry(deviceId: string): Entry {
    let entry = this.entries.get(deviceId);
    if (!entry) {
      entry = { state: 'idle', until: 0, muted: false };
      this.entries.set(deviceId, entry);
    }
    return entry;
  }

  private expire(deviceId: string): Entry {
    const entry = this.entry(deviceId);
    if (entry.state !== 'idle' && this.now() >= entry.until) {
      if (entry.state === 'awaiting_command') this.record('no_speech_timeout');
      // Processing that never completes self-recovers so voice can never lock up.
      entry.state = entry.state === 'processing' ? 'cooldown' : 'idle';
      entry.until = entry.state === 'cooldown' ? this.now() + this.cooldownMs : 0;
    }
    if (entry.state === 'cooldown' && this.now() >= entry.until) { entry.state = 'idle'; entry.until = 0; }
    return entry;
  }

  private record(event: WakeEvent): void { this.metrics.record(event); }
}
