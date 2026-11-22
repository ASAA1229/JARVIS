/**
 * Audio privacy and data-handling safeguards (D2.6).
 *
 * Raw audio is never stored by JARVIS and is never continuously uploaded. This module
 * enforces that at the one place audio enters the server:
 *
 * - Audio is accepted only as short, explicit clips: each clip is bounded by duration and a
 *   per-device rolling budget caps the total audio seconds per minute, so a client cannot
 *   stream a continuous recording through the transcription endpoint.
 * - A provider that is not local receives audio only when the owner enabled cloud speech
 *   (JARVIS_ALLOW_CLOUD_SPEECH=1) AND the routing mode permits cloud.
 * - Only metadata (duration, provider id, locality) is ever returned for logging; never bytes
 *   or transcript text.
 */
import type { SpeechToTextProvider } from './providers.js';

export interface AudioPrivacyLimits {
  maxClipSeconds: number;
  maxSecondsPerMinute: number;
}

export const DEFAULT_AUDIO_LIMITS: AudioPrivacyLimits = { maxClipSeconds: 30, maxSecondsPerMinute: 90 };

export type AudioAdmission =
  | { allowed: true; durationSeconds: number }
  | { allowed: false; reason: 'invalid_audio' | 'clip_too_long' | 'rate_limited' };

/** Duration of a validated 16 kHz mono 16-bit WAV, derived from its data chunk size. */
export function wavDurationSeconds(wav: Buffer): number | undefined {
  if (wav.length < 44 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') return undefined;
  let offset = 12;
  let byteRate = 0;
  while (offset + 8 <= wav.length) {
    const id = wav.toString('ascii', offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    if (id === 'fmt ' && offset + 20 <= wav.length) byteRate = wav.readUInt32LE(offset + 16);
    if (id === 'data') return byteRate > 0 ? Math.min(size, wav.length - offset - 8) / byteRate : undefined;
    offset += 8 + size + (size % 2);
  }
  return undefined;
}

export class AudioIngressGuard {
  private readonly history = new Map<string, Array<{ at: number; seconds: number }>>();

  constructor(
    private readonly limits: AudioPrivacyLimits = DEFAULT_AUDIO_LIMITS,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Admit one clip for a device, or refuse it. Admission consumes budget. */
  admit(deviceId: string, wav: Buffer): AudioAdmission {
    const seconds = wavDurationSeconds(wav);
    if (seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) return { allowed: false, reason: 'invalid_audio' };
    if (seconds > this.limits.maxClipSeconds) return { allowed: false, reason: 'clip_too_long' };
    const now = this.now();
    const recent = (this.history.get(deviceId) ?? []).filter((item) => now - item.at < 60_000);
    const used = recent.reduce((sum, item) => sum + item.seconds, 0);
    if (used + seconds > this.limits.maxSecondsPerMinute) {
      this.history.set(deviceId, recent);
      return { allowed: false, reason: 'rate_limited' };
    }
    recent.push({ at: now, seconds });
    this.history.set(deviceId, recent);
    return { allowed: true, durationSeconds: seconds };
  }

  forget(deviceId: string): void {
    this.history.delete(deviceId);
  }
}

/** True only when this provider may receive the audio under the owner's settings. */
export function mayReceiveAudio(provider: Pick<SpeechToTextProvider, 'local'>, settings: { allowCloudSpeech: boolean; cloudRoutingAllowed: boolean }): boolean {
  return provider.local || (settings.allowCloudSpeech && settings.cloudRoutingAllowed);
}
