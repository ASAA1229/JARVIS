import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JarvisServer } from '../src/server/server.js';

/**
 * HUD telemetry honesty tests. Server behavior is exercised for real over HTTP;
 * the browser script is checked statically (no browser runs in this suite), so
 * these do not prove on-screen rendering or real microphone behavior.
 */

const PORT = 3992;
let directory: string;
let server: JarvisServer;

describe('HUD telemetry reflects measured state', () => {
  before(async () => {
    directory = mkdtempSync(join(tmpdir(), 'jarvis-hud-telemetry-'));
    server = new JarvisServer(PORT, join(directory, 'audit.log'), join(directory, 'identity-state.json'));
    await server.start();
  });

  after(async () => {
    await server.stop();
    rmSync(directory, { recursive: true, force: true });
  });

  test('/api/status reports measured runtime facts and health checks', async () => {
    const response = await fetch(`http://127.0.0.1:${PORT}/api/status`);
    assert.equal(response.status, 200);
    const body = await response.json() as Record<string, unknown>;

    assert.equal(body.status, 'ONLINE');
    assert.equal(body.platform, process.platform);
    assert.equal(typeof body.uptimeSeconds, 'number');
    assert.ok((body.uptimeSeconds as number) >= 0);
    assert.deepEqual(body.checks, { auditIntegrity: true, identityState: true });
  });

  test('/api/status does not expose devices, keys, tokens, or audit content', async () => {
    const response = await fetch(`http://127.0.0.1:${PORT}/api/status`);
    const raw = await response.text();
    const body = JSON.parse(raw) as Record<string, unknown>;

    assert.deepEqual(Object.keys(body).sort(), ['checks', 'platform', 'status', 'uptimeSeconds']);
    assert.doesNotMatch(raw, /publicKey|deviceId|token|signature|session/i);
  });

  test('HUD markup has no hard-coded host or operating-system claims', () => {
    const html = readFileSync(join(process.cwd(), 'src', 'companion', 'hud.html'), 'utf8');
    const system = html.match(/id="tel-system">([^<]*)</);
    const host = html.match(/id="tel-host">([^<]*)</);
    assert.ok(system && host);
    assert.equal(system[1], 'CHECKING');
    assert.equal(host[1], 'CHECKING');
    assert.doesNotMatch(html, /WINDOWS 11|LOCAL 127\.0\.0\.1/);
  });

  test('HUD script drives telemetry from the status response and recovers after an outage', () => {
    const js = readFileSync(join(process.cwd(), 'src', 'companion', 'hud.js'), 'utf8');
    assert.match(js, /describePlatform\(data\.platform\)/);
    assert.match(js, /window\.location\.host/);
    assert.match(js, /HOST RECONNECTED/);
    assert.match(js, /hostWasUnreachable/);
    assert.match(js, /if \(document\.hidden\) return;/);
  });

  test('voice level display uses real analyser data and states when none is available', () => {
    const js = readFileSync(join(process.cwd(), 'src', 'companion', 'hud.js'), 'utf8');
    assert.match(js, /getByteTimeDomainData/);
    assert.match(js, /CAPTURING - NO LEVEL DATA/);
    assert.match(js, /audio is never recorded, stored, uploaded, or routed to speakers/);
    // The meter must be released when capture ends.
    assert.match(js, /function stopAudioMeter\(\)/);
    assert.match(js, /track\.stop\(\)/);
    // The listening state must no longer be drawn from a synthetic sine wave.
    const listeningBranch = js.slice(js.indexOf('if (isListening && audioMeter)'), js.indexOf('// Idle:'));
    assert.doesNotMatch(listeningBranch, /Math\.sin/);
  });

  test('redesigned HUD keeps every control id the script and smoke tests depend on', () => {
    const html = readFileSync(join(process.cwd(), 'src', 'companion', 'hud.html'), 'utf8');
    const ids = ['btn-ptt', 'reactor-core', 'reactor-container', 'waveform-canvas', 'hud-state-label', 'hud-state-sub', 'transcript-box',
      'hud-text-input', 'btn-hud-send', 'hud-approvals-slot', 'hud-tasks-feed', 'hud-pending-badge', 'btn-toggle-mic-mute',
      'btn-hands-free-toggle', 'btn-hands-free-pause', 'btn-hands-free', 'btn-speech-output', 'btn-toggle-motion',
      'btn-camera-toggle', 'task-pipeline', 'pipeline-note', 'node-core', 'node-host', 'node-session'];
    for (const id of ids) assert.match(html, new RegExp(`id="${id}"`), `missing #${id}`);
    // No inline styles or scripts: the HUD is served under a strict content-security policy.
    assert.doesNotMatch(html, /\sstyle=/i);
    assert.doesNotMatch(html, /<script(?![^>]*\ssrc=)[^>]*>/i);
  });

  test('visual state and pipeline are driven by real responses, not constants', () => {
    const js = readFileSync(join(process.cwd(), 'src', 'companion', 'hud.js'), 'utf8');
    assert.match(js, /document\.body\.dataset\.state = deriveVisualState\(mainLabel\)/);
    assert.match(js, /setPipeline\(\{ sent: 'bad' \}/);
    assert.match(js, /setPipeline\(\{ sent: 'done', policy: 'done', approval: 'skip', verify: 'done' \}/);
    assert.match(js, /setNode\('host', 'bad', 'OFFLINE'\)/);
    // Verified completion is only shown for a verified server outcome.
    assert.match(js, /data\.outcome === 'VERIFIED_SUCCESS' && data\.verified === true/);
  });

  test('companion shows laptop link state and audit-chain validity from /api/status', () => {
    const js = readFileSync(join(process.cwd(), 'src', 'companion', 'app.js'), 'utf8');
    const html = readFileSync(join(process.cwd(), 'src', 'companion', 'index.html'), 'utf8');
    assert.match(js, /setLinkState\('offline', 'LAPTOP UNREACHABLE'/);
    assert.match(js, /data\.checks\.auditIntegrity === true/);
    assert.match(html, /id="info-audit-integrity" class="val">CHECKING</);
    assert.doesNotMatch(html, /Windows 11 Home/);
    assert.doesNotMatch(html, /\sstyle=/i);
  });
});
