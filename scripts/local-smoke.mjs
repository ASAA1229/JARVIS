// Smoke test for an installed/running local JARVIS: status, HUD, owner-authorized enrollment, signed session,
// read-only request, approval-gated launch (approved through the real approve API with the test device's session), revoke.
// Usage: node scripts/local-smoke.mjs --dist <installed dist dir> --env <config .env> [--skip-launch]
import { readFileSync } from 'node:fs';
import { pathToFileURL as toUrl } from 'node:url';
import { join, resolve } from 'node:path';

const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };
const dist = resolve(arg('dist') || 'dist');
const envText = readFileSync(resolve(arg('env') || '.env'), 'utf8');
const envVal = (k) => envText.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1].trim();
const port = Number(envVal('PORT') || 3000);
const ownerToken = envVal('JARVIS_OWNER_CONTROL_TOKEN');
const base = `http://127.0.0.1:${port}`;
const { CryptoUtil } = await import(toUrl(join(dist, 'crypto', 'crypto.js')).href);

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' - ' + detail : ''}`); };
const signed = (sessionId, key, method, path, body) => {
  const timestamp = Date.now();
  const nonce = CryptoUtil.randomToken(16);
  const signature = CryptoUtil.signData(CryptoUtil.buildCanonicalRequestString(method, path, sessionId, timestamp, nonce, body), key);
  return { 'Content-Type': 'application/json', 'x-session-id': sessionId, 'x-request-timestamp': String(timestamp), 'x-request-nonce': nonce, 'x-request-signature': signature };
};
const post = async (path, headers, body) => (await fetch(base + path, { method: 'POST', headers, body: JSON.stringify(body) })).json();

const status = await (await fetch(`${base}/api/status`)).json();
check('status ONLINE', status.status === 'ONLINE' && status.checks.auditIntegrity === true, `platform=${status.platform}`);
check('HUD served', (await fetch(`${base}/hud`)).status === 200);
check('unauthenticated request rejected', (await fetch(`${base}/api/request`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"text":"x"}' })).status >= 400);

const kp = CryptoUtil.generateEd25519KeyPair();
const challenge = await post('/api/enrollment/challenge', { 'x-owner-control-token': ownerToken }, {});
check('owner challenge issued', Boolean(challenge.challengeToken));
const name = 'Local Smoke Device';
const redeem = await post('/api/enrollment/redeem', { 'Content-Type': 'application/json' }, {
  challengeToken: challenge.challengeToken, deviceName: name, publicKey: kp.publicKey,
  proofSignature: CryptoUtil.signData(`ENROLLMENT_PROOF:${challenge.challengeToken}:${name}:${CryptoUtil.sha256(kp.publicKey)}`, kp.privateKey),
});
check('device enrolled', redeem.success === true);
const ts = Date.now(); const nonce = CryptoUtil.randomToken(16);
const session = await post('/api/session', { 'Content-Type': 'application/json' }, {
  deviceId: redeem.deviceId, signature: CryptoUtil.signData(`SESSION_REQUEST:${ts}:${nonce}`, kp.privateKey), timestamp: ts, nonce,
});
check('signed session created', session.success === true);
const sid = session.sessionId;

const r1 = await post('/api/request', signed(sid, kp.privateKey, 'POST', '/api/request', { text: 'What is the OS version?' }), { text: 'What is the OS version?' });
check('read-only request COMPLETED', r1.state === 'COMPLETED', r1.state);

if (!process.argv.includes('--skip-launch')) {
  const body = { text: 'Please launch Notepad' };
  const r2 = await post('/api/request', signed(sid, kp.privateKey, 'POST', '/api/request', body), body);
  check('launch requires approval (Policy Gateway)', r2.state === 'AWAITING_APPROVAL' && Boolean(r2.approvalId), r2.state);
  const ab = { approvalId: r2.approvalId };
  const ap = await post('/api/approval/approve', signed(sid, kp.privateKey, 'POST', '/api/approval/approve', ab), ab);
  check('approved launch executed', ['COMPLETED', 'PARTIAL'].includes(ap.state), `${ap.state}/${ap.outcome}/verified=${ap.verified}`);
}

const rb = { deviceId: redeem.deviceId };
const rv = await post('/api/device/revoke', signed(sid, kp.privateKey, 'POST', '/api/device/revoke', rb), rb);
check('device revoked', rv.success === true);
const after = await fetch(`${base}/api/request`, { method: 'POST', headers: signed(sid, kp.privateKey, 'POST', '/api/request', { text: 'x' }), body: JSON.stringify({ text: 'x' }) });
check('revoked session rejected', after.status === 401, String(after.status));

const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
