#!/usr/bin/env node
/**
 * JARVIS owner recovery (JARVIS-US-005). Run on the JARVIS host while JARVIS is running.
 *
 *   npm run owner-recovery -- reset-authenticator        # lost authenticator app / TOTP
 *   npm run owner-recovery -- revoke-device <deviceId>    # lost phone, no authenticator
 *   npm run owner-recovery -- revoke-all                  # lost every management device
 *
 * Authorizes with JARVIS_OWNER_CONTROL_TOKEN from .env (never printed). The server
 * accepts this only from 127.0.0.1, rate-limits failures and audits every attempt.
 */
import { existsSync } from 'node:fs';

if (existsSync('.env')) process.loadEnvFile('.env');
const token = process.env.JARVIS_OWNER_CONTROL_TOKEN;
const port = Number(process.env.PORT || 3000);
const [command, deviceId] = process.argv.slice(2);
const actions = { 'reset-authenticator': 'reset_authenticator', 'revoke-device': 'revoke_device', 'revoke-all': 'revoke_all_devices' };

if (!actions[command] || (command === 'revoke-device' && !deviceId)) {
  console.log('Usage:\n  npm run owner-recovery -- reset-authenticator\n  npm run owner-recovery -- revoke-device <deviceId>\n  npm run owner-recovery -- revoke-all');
  process.exit(2);
}
if (!token || token.length < 32) {
  console.error('JARVIS_OWNER_CONTROL_TOKEN is not configured in .env; recovery is unavailable.');
  process.exit(1);
}

try {
  const response = await fetch(`http://127.0.0.1:${port}/api/owner/recovery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-owner-control-token': token },
    body: JSON.stringify({ action: actions[command], confirm: 'RECOVER', ...(deviceId ? { deviceId } : {}) }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.error(`Recovery failed (HTTP ${response.status}): ${payload.error ?? 'unknown error'}`);
    process.exit(1);
  }
  console.log(JSON.stringify(payload, null, 2));
} catch {
  console.error(`Could not reach JARVIS on 127.0.0.1:${port}. Start it with npm start, then retry.`);
  process.exit(1);
}
