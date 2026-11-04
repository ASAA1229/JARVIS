import { existsSync } from 'node:fs';
import process from 'node:process';

export type OwnerTokenStatus = 'configured' | 'missing' | 'placeholder' | 'invalid';

export interface RuntimeConfig {
  port: number;
  deviceStatePath: string;
  auditPath: string;
  ownerControlToken?: string;
  ownerTokenStatus: OwnerTokenStatus;
}

/** Load the local dotenv file with Node's built-in parser. Existing process
 * environment values are preserved by Node and take precedence. */
export function loadLocalEnvironmentFile(path = '.env'): boolean {
  if (!existsSync(path)) return false;
  try {
    process.loadEnvFile(path);
  } catch {
    // Do not include parser diagnostics: malformed dotenv lines can contain
    // secret values. The path and recovery action are sufficient.
    throw new Error(`Could not load ${path}; check its dotenv syntax without sharing its contents`);
  }
  return true;
}

function readPath(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
  const configured = env[name];
  if (configured === undefined) return fallback;
  const value = configured.trim();
  if (!value) throw new Error(`${name} must not be empty when set`);
  return value;
}

function readOwnerToken(raw: string | undefined): Pick<RuntimeConfig, 'ownerControlToken' | 'ownerTokenStatus'> {
  if (raw === undefined || raw.trim() === '') return { ownerTokenStatus: 'missing' };

  const token = raw.trim();
  if (/^(?:REPLACE_|YOUR_|CHANGEME|PLACEHOLDER)/i.test(token)) {
    return { ownerTokenStatus: 'placeholder' };
  }
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(token)) {
    return { ownerTokenStatus: 'invalid' };
  }
  return { ownerControlToken: token, ownerTokenStatus: 'configured' };
}

export function readOwnerTokenConfig(env: NodeJS.ProcessEnv = process.env): Pick<RuntimeConfig, 'ownerControlToken' | 'ownerTokenStatus'> {
  return readOwnerToken(env.JARVIS_OWNER_CONTROL_TOKEN);
}

export function readRuntimeConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const rawPort = env.PORT;
  let port = 3000;
  if (rawPort !== undefined) {
    const normalized = rawPort.trim();
    if (!/^\d+$/.test(normalized)) {
      throw new Error('PORT must be an integer from 1 through 65535');
    }
    port = Number(normalized);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
      throw new Error('PORT must be an integer from 1 through 65535');
    }
  }

  return {
    port,
    deviceStatePath: readPath(env, 'JARVIS_DEVICE_STATE_PATH', './data/devices.json'),
    auditPath: readPath(env, 'JARVIS_AUDIT_PATH', './data/audit.log'),
    ...readOwnerTokenConfig(env),
  };
}

export function ownerEnrollmentStatusMessage(status: OwnerTokenStatus): string {
  switch (status) {
    case 'configured':
      return 'Owner enrollment is enabled.';
    case 'missing':
      return 'Owner enrollment is disabled because JARVIS_OWNER_CONTROL_TOKEN is missing.';
    case 'placeholder':
      return 'Owner enrollment is disabled because JARVIS_OWNER_CONTROL_TOKEN is still a placeholder.';
    case 'invalid':
      return 'Owner enrollment is disabled because JARVIS_OWNER_CONTROL_TOKEN must be 32-256 URL-safe characters.';
  }
}
