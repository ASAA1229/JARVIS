#!/usr/bin/env node
// Development-only demo login setup (E3:D4.12).
//
// JARVIS has no local password. The owner signs in through ASAA SSO (the jarvis-companion client) with the shared
// Keycloak demo user (Configuration/identity/scripts/create-demo-user.ps1, group jarvis-owners). This script wires
// the local, git-ignored .env for that path and keeps the owner token configured. It never reads, stores or prints
// a password: DEMO_USER_PASSWORD lives only in the identity provider. TOTP/MFA and device-key enrollment still apply.
//
// Usage: JARVIS_ENVIRONMENT=development DEMO_USER_EMAIL=you@example.com node scripts/demo-login.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const DEFAULTS = {
  JARVIS_OIDC_ISSUER: 'http://127.0.0.1:8280/realms/asaa',
  JARVIS_OIDC_CLIENT_ID: 'jarvis-companion',
  JARVIS_OIDC_REQUIRED_ROLE: 'jarvis-owner',
};

function readKey(text, key) {
  const m = new RegExp(`^${key}=([^\r\n]*)$`, 'm').exec(text);
  return m ? m[1].trim().replace(/^["']|["']$/g, '') : '';
}

/** Pure planning step: returns { ok, error?, text, changed } and never touches a password. */
export function planDemoLogin(env, envText) {
  const effective = (key) => (env[key] ?? '').trim() || readKey(envText, key);
  const environment = effective('JARVIS_ENVIRONMENT');
  if (environment !== 'development') return { ok: false, error: 'Demo login is development-only: set JARVIS_ENVIRONMENT=development.', text: envText, changed: [] };
  if ((env.NODE_ENV ?? '').toLowerCase() === 'production') return { ok: false, error: 'Refusing to run with NODE_ENV=production.', text: envText, changed: [] };
  const email = effective('DEMO_USER_EMAIL');
  if (!/^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/.test(email)) return { ok: false, error: 'DEMO_USER_EMAIL must be set (environment or git-ignored .env) to a valid email.', text: envText, changed: [] };
  const issuer = effective('JARVIS_OIDC_ISSUER') || DEFAULTS.JARVIS_OIDC_ISSUER;
  let url;
  try { url = new URL(issuer); } catch { return { ok: false, error: 'JARVIS_OIDC_ISSUER is not a valid URL.', text: envText, changed: [] }; }
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return { ok: false, error: 'Demo login only targets a loopback identity provider.', text: envText, changed: [] };
  let text = envText;
  const changed = [];
  for (const [key, value] of Object.entries(DEFAULTS)) {
    if (readKey(text, key)) continue;
    const re = new RegExp(`^${key}=[^\r\n]*$`, 'm');
    const line = `${key}=${value}`;
    text = re.test(text) ? text.replace(re, line) : `${text}${text === '' || text.endsWith('\n') ? '' : '\n'}${line}\n`;
    changed.push(key);
  }
  return { ok: true, text, changed };
}

function main() {
  let envText = '';
  try { envText = readFileSync('.env', 'utf8'); } catch { console.error('Missing .env. Copy .env.example to .env first.'); process.exit(1); }
  const plan = planDemoLogin(process.env, envText);
  if (!plan.ok) { console.error(plan.error); process.exit(1); }
  if (plan.changed.length) writeFileSync('.env', plan.text, 'utf8');
  const token = spawnSync(process.execPath, [fileURLToPath(new URL('./configure-owner-token.mjs', import.meta.url))], { stdio: 'inherit' });
  if (token.status !== 0) process.exit(token.status ?? 1);
  console.log(`SSO settings ${plan.changed.length ? 'added to .env: ' + plan.changed.join(', ') : 'already present in .env'}.`);
  console.log('Next: start local Keycloak, run create-demo-user.ps1 (Configuration/identity/scripts), start JARVIS (npm start),');
  console.log('then open http://127.0.0.1:3000/companion and use single sign-on. Enrol the authenticator app (TOTP) at first login.');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
