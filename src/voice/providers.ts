import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Replaceable voice provider boundaries.
 *
 * Providers only turn audio into text, text into audio, or text into a
 * "wake phrase heard" decision. None of them has any execution authority: a
 * transcript is just a request string that must still go through the planner and
 * PolicyGateway like typed text.
 *
 * What is real today:
 *  - WhisperCppProvider: genuinely local, offline speech-to-text, but only when
 *    the owner installs whisper.cpp and a model and sets JARVIS_WHISPER_CLI and
 *    JARVIS_WHISPER_MODEL. It is reported unavailable otherwise.
 *  - TranscriptWakePhrase: a configurable wake-phrase matcher over a transcript.
 *    It does NOT listen to audio itself; the transcript comes from whichever STT
 *    is in use (today the browser's recognizer, which may use a vendor cloud).
 *  - Piper TTS lives in piperTts.ts and is wired through the existing endpoint.
 *  - Local audio-level wake-word detection is integrated in the HUD through the optional
 *    onnx-wakeword Web SDK assets installed by scripts/setup-local-wake-word.ps1.
 *    Runtime assets are kept out of Git and served only through a filename allowlist.
 */

export interface TranscriptionResult {
  text: string;
  provider: string;
  local: boolean;
}

export interface SpeechToTextProvider {
  readonly id: string;
  /** True only when audio never leaves this machine. */
  readonly local: boolean;
  isAvailable(): Promise<boolean>;
  /** Input is a 16 kHz, mono, 16-bit PCM WAV file. */
  transcribe(wav: Buffer, signal?: AbortSignal): Promise<TranscriptionResult>;
}

export interface WakePhraseMatcher {
  readonly id: string;
  /** True when matching works on raw audio locally; false when it only inspects a transcript. */
  readonly operatesOnAudio: boolean;
  /** Returns the command text following the wake phrase, or undefined if the phrase was not heard. */
  match(transcript: string): string | undefined;
}

export interface VoicePrivacySettings {
  /** Cloud speech services are used only when this is explicitly enabled by the owner. */
  allowCloudSpeech: boolean;
}

export function readVoicePrivacySettings(): VoicePrivacySettings {
  return { allowCloudSpeech: process.env.JARVIS_ALLOW_CLOUD_SPEECH === '1' };
}

const MAX_WAV_BYTES = 3 * 1024 * 1024;

/** Validate a WAV buffer is the exact format whisper.cpp expects. Returns an error message or undefined. */
export function validateWav16kMono(wav: Buffer): string | undefined {
  if (wav.length < 44 || wav.length > MAX_WAV_BYTES) return `Audio must be a WAV file of at most ${MAX_WAV_BYTES / 1024 / 1024} MB.`;
  if (wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') return 'Audio is not a RIFF/WAVE file.';

  // Validate the container's declared size and every chunk boundary before reading
  // format fields or passing the bytes to a local speech-recognition process.
  const riffSize = wav.readUInt32LE(4);
  const riffEnd = riffSize + 8;
  if (riffSize < 36 || riffEnd !== wav.length) return 'Audio has an invalid RIFF size.';

  let offset = 12;
  let formatOk = false;
  let hasData = false;
  while (offset < riffEnd) {
    if (riffEnd - offset < 8) return 'Audio contains a truncated WAV chunk header.';
    const chunkId = wav.toString('ascii', offset, offset + 4);
    const chunkSize = wav.readUInt32LE(offset + 4);
    const payloadStart = offset + 8;
    if (chunkSize > riffEnd - payloadStart) return 'Audio contains a truncated WAV chunk.';
    const payloadEnd = payloadStart + chunkSize;

    if (chunkId === 'fmt ') {
      if (chunkSize < 16) return 'Audio contains an invalid WAV format chunk.';
      const audioFormat = wav.readUInt16LE(payloadStart);
      const channels = wav.readUInt16LE(payloadStart + 2);
      const sampleRate = wav.readUInt32LE(payloadStart + 4);
      const bits = wav.readUInt16LE(payloadStart + 14);
      formatOk = audioFormat === 1 && channels === 1 && sampleRate === 16000 && bits === 16;
    }
    if (chunkId === 'data') hasData = chunkSize > 0;

    offset = payloadEnd + (chunkSize % 2);
    if (offset > riffEnd) return 'Audio contains a truncated WAV chunk.';
  }
  if (offset !== riffEnd) return 'Audio contains an invalid WAV chunk layout.';
  if (!formatOk) return 'Audio must be 16 kHz, mono, 16-bit PCM WAV.';
  if (!hasData) return 'Audio contains no samples.';
  return undefined;
}

/** Offline speech-to-text through a locally installed whisper.cpp command-line build. */
export class WhisperCppProvider implements SpeechToTextProvider {
  public readonly id = 'whisper.cpp';
  public readonly local = true;

  constructor(private readonly cliPath: string, private readonly modelPath: string, private readonly language = 'en') {}

  public static fromEnvironment(): WhisperCppProvider | undefined {
    const cli = process.env.JARVIS_WHISPER_CLI;
    const model = process.env.JARVIS_WHISPER_MODEL;
    if (!cli || !model) return undefined;
    return new WhisperCppProvider(cli, model, process.env.JARVIS_WHISPER_LANGUAGE || 'en');
  }

  public async isAvailable(): Promise<boolean> {
    return existsSync(this.cliPath) && existsSync(this.modelPath);
  }

  public async transcribe(wav: Buffer, signal?: AbortSignal): Promise<TranscriptionResult> {
    const invalid = validateWav16kMono(wav);
    if (invalid) throw new Error(invalid);
    if (!(await this.isAvailable())) throw new Error('Local speech recognition is not installed or its model is missing.');
    if (!/^[a-z]{2,3}$/.test(this.language)) throw new Error('Configured recognition language is invalid.');

    const temporary = join(tmpdir(), `jarvis-stt-${randomBytes(8).toString('hex')}.wav`);
    await fs.writeFile(temporary, wav, { flag: 'wx', mode: 0o600 });
    try {
      const text = await new Promise<string>((resolve, reject) => {
        if (signal?.aborted) {
          reject(new Error('Local speech recognition was cancelled.'));
          return;
        }

        const child = spawn(this.cliPath, ['-m', this.modelPath, '-f', temporary, '-l', this.language, '-nt', '-np'], {
          shell: false,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let output = '';
        let settled = false;
        let stopError: Error | undefined;
        let killEscalation: ReturnType<typeof setTimeout> | null = null;
        const cleanup = (): void => {
          clearTimeout(timer);
          if (killEscalation !== null) clearTimeout(killEscalation);
          signal?.removeEventListener('abort', onAbort);
        };
        const finish = (error?: Error): void => {
          if (settled) return;
          settled = true;
          cleanup();
          if (error) reject(error); else resolve(output);
        };
        const requestStop = (error: Error): void => {
          if (settled || stopError) return;
          stopError = error;
          if (child.exitCode !== null || child.signalCode !== null) return;
          try {
            child.kill();
          } catch {
            // The close/error event remains authoritative for process completion.
          }
          // Do not remove the temporary WAV or settle the request until the child
          // has actually closed. Escalate once if a native process ignores the
          // initial termination request.
          killEscalation = setTimeout(() => {
            if (child.exitCode === null && child.signalCode === null) {
              try { child.kill('SIGKILL'); } catch { /* close event handles completion */ }
            }
          }, 2_000);
        };
        const onAbort = (): void => {
          requestStop(new Error('Local speech recognition was cancelled.'));
        };
        const timer = setTimeout(() => {
          requestStop(new Error('Local speech recognition timed out.'));
        }, 60_000);

        signal?.addEventListener('abort', onAbort, { once: true });
        // Close the race between the initial check and listener registration.
        if (signal?.aborted) {
          onAbort();
        }
        child.stdout?.on('data', (chunk: Buffer) => {
          if (output.length < 20_000) output += chunk.toString('utf8').slice(0, 20_000 - output.length);
        });
        // Drain stderr even though provider diagnostics are deliberately not
        // returned to callers; an unread pipe can otherwise stall the child.
        child.stderr?.on('data', () => undefined);
        child.on('error', () => {
          finish(stopError ?? new Error('Local speech recognition could not be started.'));
        });
        child.on('close', (code) => {
          if (stopError) finish(stopError);
          else if (code === 0) finish();
          else finish(new Error('Local speech recognition failed.'));
        });
      });
      // Whisper emits bracketed non-speech markers such as [BLANK_AUDIO]; those are not words.
      const cleaned = text.replace(/\[[^\]]*\]/g, ' ').replace(/\s+/g, ' ').trim();
      return { text: cleaned, provider: this.id, local: true };
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }
}

/** Configurable wake-phrase matching over a transcript. Does not hear audio. */
export class TranscriptWakePhrase implements WakePhraseMatcher {
  public readonly id = 'transcript-wake-phrase';
  public readonly operatesOnAudio = false;
  private readonly phrase: string;

  constructor(phrase = process.env.JARVIS_WAKE_PHRASE || 'hey jarvis') {
    const normalized = TranscriptWakePhrase.normalize(phrase);
    this.phrase = normalized.length >= 4 && normalized.length <= 40 ? normalized : 'hey jarvis';
  }

  private static normalize(value: string): string {
    return value.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  }

  public getPhrase(): string {
    return this.phrase;
  }

  public match(transcript: string): string | undefined {
    const normalized = TranscriptWakePhrase.normalize(transcript);
    if (normalized === this.phrase) return '';
    if (normalized.startsWith(this.phrase + ' ')) return normalized.slice(this.phrase.length + 1).trim();
    return undefined;
  }
}

/** Chooses providers under the owner's privacy settings. Cloud providers are never selected implicitly. */
export class VoiceProviderRegistry {
  private readonly stt: SpeechToTextProvider[] = [];

  constructor(private readonly privacy: VoicePrivacySettings = readVoicePrivacySettings()) {
    const whisper = WhisperCppProvider.fromEnvironment();
    if (whisper) this.stt.push(whisper);
  }

  public register(provider: SpeechToTextProvider): void {
    if (!provider.local && !this.privacy.allowCloudSpeech) {
      throw new Error('Cloud speech providers are disabled by the voice privacy settings.');
    }
    this.stt.push(provider);
  }

  public async describe(): Promise<{ stt: Array<{ id: string; local: boolean; available: boolean }>; cloudSpeechAllowed: boolean; wake: { id: string; operatesOnAudio: boolean; phrase: string }; browserRecognition: string }> {
    const wake = new TranscriptWakePhrase();
    const stt = [];
    for (const provider of this.stt) stt.push({ id: provider.id, local: provider.local, available: await provider.isAvailable() });
    return {
      stt,
      cloudSpeechAllowed: this.privacy.allowCloudSpeech,
      wake: { id: wake.id, operatesOnAudio: wake.operatesOnAudio, phrase: wake.getPhrase() },
      browserRecognition: 'The HUD still uses the browser speech recognizer unless wired to a local provider; the browser may send audio to a vendor service.',
    };
  }

  public async pickLocalStt(): Promise<SpeechToTextProvider | undefined> {
    for (const provider of this.stt) {
      if (provider.local && await provider.isAvailable()) return provider;
    }
    return undefined;
  }
}
