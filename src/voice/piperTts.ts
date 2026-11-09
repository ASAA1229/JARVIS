import { spawn } from 'node:child_process';

/**
 * Local Piper TTS adapter. It never invokes a shell and accepts only configured
 * executable/model paths. Audio is generated on demand; no text is persisted.
 */
export interface PiperConfig {
  executable: string;
  model: string;
  timeoutMs?: number;
}

export const MAX_PIPER_AUDIO_BYTES = 16 * 1024 * 1024;
const MAX_PIPER_STDERR_BYTES = 8 * 1024;

/**
 * Validate the WAV container returned by Piper before exposing it to the caller.
 * Piper models may use sample rates other than the STT input's fixed 16 kHz, so
 * this deliberately validates container/chunk integrity rather than one rate.
 */
export function validatePiperWav(audio: Buffer): string | undefined {
  if (audio.length < 44 || audio.length > MAX_PIPER_AUDIO_BYTES) {
    return `Speech audio size must be between 44 bytes and ${MAX_PIPER_AUDIO_BYTES / 1024 / 1024} MB.`;
  }
  if (audio.toString('ascii', 0, 4) !== 'RIFF' || audio.toString('ascii', 8, 12) !== 'WAVE') {
    return 'Piper output is not a RIFF/WAVE file.';
  }

  const riffEnd = audio.readUInt32LE(4) + 8;
  if (riffEnd !== audio.length || riffEnd < 44) return 'Piper output has an invalid RIFF size.';

  let offset = 12;
  let hasFormat = false;
  let hasData = false;
  while (offset < riffEnd) {
    if (riffEnd - offset < 8) return 'Piper output contains a truncated WAV chunk header.';
    const id = audio.toString('ascii', offset, offset + 4);
    const size = audio.readUInt32LE(offset + 4);
    const payloadStart = offset + 8;
    if (size > riffEnd - payloadStart) return 'Piper output contains a truncated WAV chunk.';
    if (id === 'fmt ') {
      if (size < 16) return 'Piper output contains an invalid WAV format chunk.';
      hasFormat = true;
    }
    if (id === 'data' && size > 0) hasData = true;
    offset = payloadStart + size + (size % 2);
    if (offset > riffEnd) return 'Piper output contains a truncated WAV chunk.';
  }
  if (offset !== riffEnd || !hasFormat || !hasData) {
    return 'Piper output has an incomplete WAV layout.';
  }
  return undefined;
}

export class PiperTtsProvider {
  constructor(private readonly config: PiperConfig) {}

  async synthesize(text: string, signal?: AbortSignal): Promise<Buffer> {
    const normalized = text.trim();
    if (!normalized || normalized.length > 1200) {
      throw new Error('Speech text must contain 1–1200 characters.');
    }
    if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(normalized)) {
      throw new Error('Speech text contains unsupported control characters.');
    }

    if (signal?.aborted) throw new Error('Local speech generation was cancelled.');

    const child = spawn(this.config.executable, ['--model', this.config.model, '--output_file', '-'], {
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const timeoutMs = this.config.timeoutMs ?? 20_000;
    const chunks: Buffer[] = [];
    const errors: Buffer[] = [];
    let stderrBytes = 0;
    let stdoutBytes = 0;
    let settled = false;

    return await new Promise<Buffer>((resolve, reject) => {
      const onAbort = (): void => fail(new Error('Local speech generation was cancelled.'));
      const cleanup = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      };
      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        cleanup();
        child.kill();
        reject(error);
      };
      const timer = setTimeout(() => {
        fail(new Error('Local speech generation timed out.'));
      }, timeoutMs);

      signal?.addEventListener('abort', onAbort, { once: true });
      child.stdout.on('data', (chunk: Buffer) => {
        if (settled) return;
        stdoutBytes += chunk.length;
        if (stdoutBytes > MAX_PIPER_AUDIO_BYTES) {
          fail(new Error('Local speech output exceeded the configured audio size limit.'));
          return;
        }
        chunks.push(Buffer.from(chunk));
      });
      child.stderr.on('data', (chunk: Buffer) => {
        if (stderrBytes >= MAX_PIPER_STDERR_BYTES) return;
        const remaining = MAX_PIPER_STDERR_BYTES - stderrBytes;
        const kept = Buffer.from(chunk.subarray(0, remaining));
        errors.push(kept);
        stderrBytes += kept.length;
      });
      child.once('error', (error) => {
        fail(new Error(`Could not start the local Piper executable: ${error.message}`));
      });
      child.stdin.once('error', (error) => {
        // A child may exit before consuming its input; the close handler reports
        // its exit code and bounded stderr, so avoid an unhandled stream error.
        if (!settled && (error as NodeJS.ErrnoException).code !== 'EPIPE') {
          fail(new Error(`Could not provide text to the local Piper executable: ${error.message}`));
        }
      });
      child.once('close', (code) => {
        if (settled) return;
        settled = true;
        cleanup();
        const audio = Buffer.concat(chunks);
        const invalid = validatePiperWav(audio);
        if (code !== 0 || invalid) {
          const detail = Buffer.concat(errors).toString('utf8').slice(0, 500);
          reject(new Error(`Piper did not return valid WAV audio (exit ${code ?? 'unknown'}).${invalid ? ' ' + invalid : ''}${detail ? ' ' + detail : ''}`));
          return;
        }
        resolve(audio);
      });
      child.stdin.end(normalized + '\n');
    });
  }
}

/** Build a provider only when local TTS is explicitly configured. */
export function createConfiguredPiperProvider(env: NodeJS.ProcessEnv = process.env): PiperTtsProvider | null {
  const executable = env.JARVIS_PIPER_EXECUTABLE?.trim();
  const model = env.JARVIS_PIPER_MODEL?.trim();
  if (!executable && !model) return null;
  if (!executable || !model) {
    throw new Error('Configure both JARVIS_PIPER_EXECUTABLE and JARVIS_PIPER_MODEL, or leave both unset.');
  }
  return new PiperTtsProvider({ executable, model });
}
