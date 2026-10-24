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
  privacyNotice: string;
}

export class VoiceManager {
  private state: SpeechState = SpeechState.IDLE;
  private isMuted: boolean = false;
  private currentTranscript: string = '';
  private captureTimeout: ReturnType<typeof setTimeout> | null = null;

  public readonly policy: VoicePrivacyPolicy = {
    continuousListeningAllowed: false,
    wakeWordEnabled: false,
    maxCaptureDurationSeconds: 15,
    privacyNotice: 'Microphone is active ONLY during push-to-talk. No continuous recording or wake-word listening is active.',
  };

  /**
   * Starts push-to-talk voice capture with safety bounds.
   */
  public startPushToTalk(onTimeout?: () => void): { allowed: boolean; reason?: string } {
    if (this.isMuted) {
      this.state = SpeechState.DISABLED;
      return { allowed: false, reason: 'Microphone is currently muted by user privacy control.' };
    }

    this.state = SpeechState.LISTENING;
    this.currentTranscript = '';

    // Safety timeout: automatically cancel capture after max duration
    if (this.captureTimeout) clearTimeout(this.captureTimeout);
    this.captureTimeout = setTimeout(() => {
      if (this.state === SpeechState.LISTENING) {
        this.stopPushToTalk();
        if (onTimeout) onTimeout();
      }
    }, this.policy.maxCaptureDurationSeconds * 1000);

    return { allowed: true };
  }

  /**
   * Stops active capture.
   */
  public stopPushToTalk(): void {
    if (this.captureTimeout) {
      clearTimeout(this.captureTimeout);
      this.captureTimeout = null;
    }
    if (this.state === SpeechState.LISTENING) {
      this.state = this.currentTranscript ? SpeechState.CONFIRMING : SpeechState.IDLE;
    }
  }

  /**
   * Cancels active capture and discards transcript.
   */
  public cancelCapture(): void {
    if (this.captureTimeout) {
      clearTimeout(this.captureTimeout);
      this.captureTimeout = null;
    }
    this.state = SpeechState.IDLE;
    this.currentTranscript = '';
  }

  /**
   * Updates recognized transcript.
   */
  public updateTranscript(text: string): void {
    if (this.state === SpeechState.LISTENING || this.state === SpeechState.TRANSCRIBING) {
      this.currentTranscript = text.trim();
    }
  }

  /**
   * Toggles hard mute state.
   */
  public toggleMute(): boolean {
    this.isMuted = !this.isMuted;
    if (this.isMuted) {
      this.cancelCapture();
      this.state = SpeechState.DISABLED;
    } else {
      this.state = SpeechState.IDLE;
    }
    return this.isMuted;
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
}
