/**
 * Local persona model: generates an Ollama Modelfile (base model + persona) and
 * runs `ollama create jarvis-personal`. Execution happens only inside the approved
 * `ai:model_build` task (PolicyGateway, owner approval, audit); never from a route.
 */
import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ExecutionResult } from '../core/types.js';
import { VerificationOutcome } from '../core/types.js';
import { MAX_PERSONA_CHARS } from './studioStore.js';

export const LOCAL_MODEL_NAME = 'jarvis-personal';
export const MODEL_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/;

export function studioDataDir(): string {
  return resolve(process.env.JARVIS_STUDIO_DIR || './data/studio');
}

/** Pure: the Modelfile text. The persona cannot break out of the SYSTEM block. */
export function buildModelfile(baseModel: string, persona: string): string {
  if (!MODEL_NAME_PATTERN.test(baseModel)) throw new Error('Base model name is invalid.');
  const text = persona.trim();
  if (!text) throw new Error('Write a persona first.');
  if (text.length > MAX_PERSONA_CHARS) throw new Error('Persona is too long.');
  const safe = text.replace(/"""/g, '\'\'\'').replace(/\r\n?/g, '\n');
  return `FROM ${baseModel}\nSYSTEM """${safe}"""\nPARAMETER temperature 0.4\n`;
}

type Runner = (file: string, args: string[], options: { timeout: number; maxBuffer: number }) => Promise<{ stdout: string; stderr: string }>;

const defaultRunner: Runner = (file, args, options) => new Promise((resolvePromise, reject) => {
  execFile(file, args, { ...options, windowsHide: true, shell: false }, (error, stdout, stderr) => {
    if (error) reject(error);
    else resolvePromise({ stdout: String(stdout), stderr: String(stderr) });
  });
});

export async function buildLocalModel(parameters: Record<string, unknown>, run: Runner = defaultRunner): Promise<ExecutionResult> {
  try {
    const baseModel = String(parameters['baseModel'] ?? '');
    const modelfile = buildModelfile(baseModel, String(parameters['persona'] ?? ''));
    const dir = join(studioDataDir(), 'models');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `Modelfile.${LOCAL_MODEL_NAME}`);
    writeFileSync(file, modelfile, { encoding: 'utf8', mode: 0o600 });
    await run('ollama', ['create', LOCAL_MODEL_NAME, '-f', file], { timeout: 10 * 60 * 1000, maxBuffer: 1024 * 1024 });
    return {
      success: true,
      outcome: VerificationOutcome.VERIFIED_SUCCESS,
      data: { model: LOCAL_MODEL_NAME, baseModel, modelfile: file },
      evidence: { localModelBuild: true },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message.split('\n')[0]!.slice(0, 200) : 'Model build failed';
    return { success: false, outcome: VerificationOutcome.VERIFIED_FAILURE, error: `Local model build failed: ${message}`, evidence: { localModelBuild: true } };
  }
}
