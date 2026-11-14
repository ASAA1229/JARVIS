export enum SpeechState {
  DISABLED = 'DISABLED',
  IDLE = 'IDLE',
  LISTENING = 'LISTENING',
  TRANSCRIBING = 'TRANSCRIBING',
  CONFIRMING = 'CONFIRMING',
  ERROR = 'ERROR',
}

export interface VoiceCaptureResult {
  transcript: string;
  confidence: number;
  isFinal: boolean;
  capturedAt: number;
}

export interface VoicePrivacyPolicy {
  continuousListeningAllowed: boolean;
  wakeWordEnabled: boolean;
  maxCaptureDurationSeconds: number;
  maxTranscriptionDurationSeconds: number;
  privacyNotice: string;
}

export interface VoiceCaptureStartResult {
  allowed: boolean;
  reason?: string;
}

const MAX_TRANSCRIPT_LENGTH = 1200;

export class VoiceManager {
  private state: SpeechState = SpeechState.IDLE;
  private isMuted = false;
  private currentTranscript = '';
  private captureTimeout: ReturnType<typeof setTimeout> | null = null;
  private transcriptionTimeout: ReturnType<typeof setTimeout> | null = null;
  private captureGeneration = 0;

  public readonly policy: VoicePrivacyPolicy = {
    continuousListeningAllowed: false,
    wakeWordEnabled: false,
    maxCaptureDurationSeconds: 15,
    maxTranscriptionDurationSeconds: 10,
    privacyNotice: 'Microphone is active only during an explicitly started capture. No continuous recording or wake-word listening is enabled by this manager.',
  };

  /**
   * Starts one bounded push-to-talk capture.
   *
   * A second start is rejected while a capture or transcript review is active;
   * it must never silently replace an in-flight transcript.
   */
  public startPushToTalk(onTimeout?: () => void): VoiceCaptureStartResult {
    if (this.isMuted) {
      this.state = SpeechState.DISABLED;
      return { allowed: false, reason: 'Microphone is currently muted by user privacy control.' };
    }

    if (this.state === SpeechState.LISTENING
      || this.state === SpeechState.TRANSCRIBING
      || this.state === SpeechState.CONFIRMING) {
      return { allowed: false, reason: 'A voice capture or transcript review is already active.' };
    }

    const durationSeconds = this.policy.maxCaptureDurationSeconds;
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > 120) {
      return { allowed: false, reason: 'Voice capture duration must be greater than 0 and no more than 120 seconds.' };
    }

    this.clearCaptureTimeout();
    const generation = ++this.captureGeneration;
    this.currentTranscript = '';
    this.state = SpeechState.LISTENING;

    this.captureTimeout = setTimeout(() => {
      if (generation !== this.captureGeneration || this.state !== SpeechState.LISTENING) return;

      this.captureTimeout = null;
      this.state = this.currentTranscript ? SpeechState.CONFIRMING : SpeechState.IDLE;
      this.captureGeneration += 1;

      // The timeout has already stopped this capture. A callback failure must
      // not resurrect capture state or affect a later session.
      try {
        onTimeout?.();
      } catch {
        // Timeout notification is advisory; privacy timeout enforcement wins.
      }
    }, durationSeconds * 1000);

    return { allowed: true };
  }

  /** Stops active microphone capture and preserves non-empty text for review. */
  public stopPushToTalk(): void {
    if (this.state !== SpeechState.LISTENING) return;

    this.clearCaptureTimeout();
    this.captureGeneration += 1;
    this.state = this.currentTranscript ? SpeechState.CONFIRMING : SpeechState.IDLE;
  }

  /** Cancels capture and discards its transcript. */
  public cancelCapture(): void {
    this.clearCaptureTimeout();
    this.clearTranscriptionTimeout();
    this.captureGeneration += 1;
    this.currentTranscript = '';
    this.state = this.isMuted ? SpeechState.DISABLED : SpeechState.IDLE;
  }

  /**
   * Records a transcript only while the current capture is active.
   * Input is bounded to the same maximum length accepted by the HUD voice path.
   */
  public updateTranscript(text: string): void {
    if (this.state !== SpeechState.LISTENING && this.state !== SpeechState.TRANSCRIBING) return;
    this.currentTranscript = text.trim().slice(0, MAX_TRANSCRIPT_LENGTH);
  }

  /** Ends microphone capture and marks the bounded transcript-processing phase. */
  public beginTranscription(): boolean {
    if (this.isMuted || this.state !== SpeechState.LISTENING) return false;
    this.clearCaptureTimeout();
    this.clearTranscriptionTimeout();

    const durationSeconds = this.policy.maxTranscriptionDurationSeconds;
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > 120) {
      this.state = this.currentTranscript ? SpeechState.CONFIRMING : SpeechState.ERROR;
      return false;
    }

    const generation = ++this.captureGeneration;
    this.state = SpeechState.TRANSCRIBING;
    this.transcriptionTimeout = setTimeout(() => {
      if (generation !== this.captureGeneration || this.state !== SpeechState.TRANSCRIBING) return;

      this.transcriptionTimeout = null;
      this.captureGeneration += 1;
      // A stalled recognizer must not lock voice input indefinitely. Keep any
      // partial text for explicit review; never dispatch it automatically.
      this.state = this.currentTranscript ? SpeechState.CONFIRMING : SpeechState.IDLE;
    }, durationSeconds * 1000);
    return true;
  }

  /** Completes transcription and makes the recognized text available for review. */
  public finishTranscription(): boolean {
    if (this.isMuted || this.state !== SpeechState.TRANSCRIBING) return false;
    this.clearTranscriptionTimeout();
    this.state = this.currentTranscript ? SpeechState.CONFIRMING : SpeechState.IDLE;
    return true;
  }

  /** Toggles the hard privacy mute; muting always cancels and discards active work. */
  public toggleMute(): boolean {
    this.isMuted = !this.isMuted;
    if (this.isMuted) {
      this.cancelCapture();
    } else {
      this.state = SpeechState.IDLE;
    }
    return this.isMuted;
  }

  /** Releases timers when the owning UI/service is disposed. */
  public dispose(): void {
    this.cancelCapture();
  }

  public getState(): SpeechState {
    return this.state;
  }

  public getIsMuted(): boolean {
    return this.isMuted;
  }

  public getCurrentTranscript(): string {
    return this.currentTranscript;
  }

  private clearCaptureTimeout(): void {
    if (this.captureTimeout !== null) {
      clearTimeout(this.captureTimeout);
      this.captureTimeout = null;
    }
  }

  private clearTranscriptionTimeout(): void {
    if (this.transcriptionTimeout !== null) {
      clearTimeout(this.transcriptionTimeout);
      this.transcriptionTimeout = null;
    }
  }
}
