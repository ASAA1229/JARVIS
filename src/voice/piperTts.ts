import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';

/**
 * Local Piper TTS adapter. It never invokes a shell and accepts only configured
 * executable/model paths. Audio is generated on demand; no text is persisted.
 */
export interface PiperConfig {
  executable: string;
  model: string;
  timeoutMs?: number;
}

export class PiperTtsProvider {
  constructor(private readonly config: PiperConfig) {}

  async synthesize(text: string): Promise<Buffer> {
    const normalized = text.trim();
    if (!normalized || normalized.length > 1200) {
      throw new Error('Speech text must contain 1–1200 characters.');
    }
    if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(normalized)) {
      throw new Error('Speech text contains unsupported control characters.');
    }

    const child = spawn(this.config.executable, ['--model', this.config.model, '--output_file', '-'], {
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const timeoutMs = this.config.timeoutMs ?? 20_000;
    const chunks: Buffer[] = [];
    const errors: Buffer[] = [];
    let settled = false;

    return await new Promise<Buffer>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill();
        reject(new Error('Local speech generation timed out.'));
      }, timeoutMs);

      child.stdout.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      child.stderr.on('data', (chunk: Buffer) => {
        if (Buffer.concat(errors).length < 8192) errors.push(Buffer.from(chunk));
      });
      child.once('error', (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error(`Could not start the local Piper executable: ${error.message}`));
      });
      child.once('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const audio = Buffer.concat(chunks);
        if (code !== 0 || audio.length < 44 || audio.toString('ascii', 0, 4) !== 'RIFF' ||
            audio.toString('ascii', 8, 12) !== 'WAVE') {
          const detail = Buffer.concat(errors).toString('utf8').slice(0, 500);
          reject(new Error(`Piper did not return valid WAV audio (exit ${code ?? 'unknown'}).${detail ? ' ' + detail : ''}`));
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
