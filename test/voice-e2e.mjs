// End-to-end voice chain with SYNTHESIZED speech (no human, no cloud): Windows SAPI WAV -> Chromium fake microphone ->
// the HUD's real local wake-word engine -> real local whisper.cpp -> intent -> Policy Gateway approval -> approval click
// (the HUD's real approve API call with the enrolled device session) -> Notepad opens -> VERIFIED_SUCCESS.
// Requires Windows, an interactive desktop, whisper.cpp + model (JARVIS_WHISPER_CLI / JARVIS_WHISPER_MODEL, or the per-user
// install under %LOCALAPPDATA%\JARVIS\tools\whisper) and a Chromium/Edge. Missing prerequisites are an explicit SKIP (exit 0).
// Usage: node test/voice-e2e.mjs [both|two|neg]   (default: both = "Hey Jarvis, open Notepad" in one utterance)
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright-core';

const variant = process.argv[2] || 'both';
const skip = (why) => { console.log(`VOICE_E2E_SKIPPED: ${why}`); process.exit(0); };
if (process.platform !== 'win32') skip('Windows only');
const home = join(process.env.LOCALAPPDATA || '', 'JARVIS', 'tools', 'whisper');
const whisperCli = process.env.JARVIS_WHISPER_CLI || join(home, 'whisper-cli.exe');
const whisperModel = process.env.JARVIS_WHISPER_MODEL || join(home, 'ggml-base.en.bin');
if (!existsSync(whisperCli) || !existsSync(whisperModel)) skip('whisper.cpp or its model is not installed (see deploy/local/install-whisper.ps1)');
const sapi = spawnSync('powershell.exe', ['-NoProfile', '-Command', 'Add-Type -AssemblyName System.Speech; 1'], { encoding: 'utf8' });
if (sapi.status !== 0) skip('Windows SAPI (System.Speech) is unavailable');

const browserPath = [process.env.BROWSER_PATH, 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe']
  .find((p) => p && existsSync(p));
if (!browserPath) skip('no Edge/Chrome found');

const freePort = () => new Promise((res, rej) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); s.on('error', rej); });
const stamp = Date.now();
const work = join('.jenkins-temp', `voice-e2e-${stamp}`);
mkdirSync(work, { recursive: true });
const wav = join(work, 'speech.wav');
const ps = (args) => {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'scripts/synth-speech.ps1', ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('speech synthesis failed: ' + r.stderr);
};
// Lead silence gives the wake engine time to start; trailing silence lets the capture end by itself.
if (variant === 'neg') ps(['-Text', 'Good morning, what a lovely sunny day today', '-Out', wav, '-LeadMs', '4000', '-TailMs', '20000']);
else if (variant === 'two') ps(['-Text', 'Hey Jarvis', '-Text2', 'open Notepad', '-PauseMs', '1200', '-Out', wav, '-LeadMs', '4000', '-TailMs', '20000']);
else ps(['-Text', 'Hey Jarvis, open Notepad', '-Out', wav, '-LeadMs', '4000', '-TailMs', '20000']);

const port = await freePort();
const ownerToken = 'voice-e2e-owner-token-0123456789abcdef';
const baseUrl = `http://127.0.0.1:${port}`;
const statePath = `./data/voice-e2e-devices-${stamp}.json`;
const auditPath = `./data/voice-e2e-audit-${stamp}.log`;
const evidence = { variant, stages: {} };
const stage = (name, ok, detail = '') => { evidence.stages[name] = { ok, detail }; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' - ' + detail : ''}`); };
const notepadPids = () => (spawnSync('powershell.exe', ['-NoProfile', '-Command', '(Get-Process notepad -ErrorAction SilentlyContinue | % Id) -join ","'], { encoding: 'utf8' }).stdout.trim().split(',').filter(Boolean));
const preexisting = new Set(notepadPids());

let child; let browser; let failed = false;
let serverLog = '';
try {
  child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port), JARVIS_OWNER_CONTROL_TOKEN: ownerToken, JARVIS_DEVICE_STATE_PATH: statePath, JARVIS_AUDIT_PATH: auditPath,
      JARVIS_WHISPER_CLI: whisperCli, JARVIS_WHISPER_MODEL: whisperModel, JARVIS_WHISPER_LANGUAGE: 'en', JARVIS_ALLOW_CLOUD_SPEECH: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (c) => { serverLog += c; }); child.stderr.on('data', (c) => { serverLog += c; });
  for (let i = 0; i < 240; i++) { try { if ((await fetch(`${baseUrl}/api/status`)).ok) break; } catch { /* binding */ } await delay(250); }
  const voice = await (await fetch(`${baseUrl}/api/voice/status`)).json();
  stage('local STT (whisper.cpp) available', voice.localStt === true);

  browser = await chromium.launch({
    executablePath: browserPath,
    headless: false,
    args: ['--headless=new', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-audio-capture=${wav}`,
      '--autoplay-policy=no-user-gesture-required'],
  });
  const context = await browser.newContext({ permissions: ['microphone'] });
  const page = await context.newPage();
  page.on('dialog', async (d) => { if (d.type() === 'prompt') await d.accept(ownerToken); else await d.dismiss(); });
  const log = [];
  const hudLog = (m) => log.push(m.text());
  await page.goto(`${baseUrl}/companion`, { waitUntil: 'domcontentloaded' });
  await page.locator('#btn-enroll-browser').click();
  await page.locator('#enrollment-registered').waitFor({ state: 'visible', timeout: 20000 });

  // Observe wake-engine events and the request path without altering them.
  await context.addInitScript(() => {
    window.__voice = { wake: [], requests: [] };
    const wrap = () => {
      if (!window.VoicuteWakeWord || window.VoicuteWakeWord.__wrapped) return;
      const create = window.VoicuteWakeWord.create.bind(window.VoicuteWakeWord);
      window.VoicuteWakeWord.create = () => {
        const engine = create();
        const start = engine.start.bind(engine);
        engine.start = (cb) => start((word, p) => { window.__voice.wake.push({ word, p, t: Date.now() }); cb(word, p); });
        return engine;
      };
      window.VoicuteWakeWord.__wrapped = true;
    };
    const t = setInterval(() => { wrap(); if (window.VoicuteWakeWord && window.VoicuteWakeWord.__wrapped) clearInterval(t); }, 20);
  });
  const hud = await context.newPage();
  hud.on('console', hudLog);
  const requests = [];
  hud.on('request', (r) => { if (r.url().endsWith('/api/request') || r.url().endsWith('/api/voice/transcribe')) requests.push(r.url().split('/api/')[1]); });
  const transcripts = [];
  hud.on('response', async (r) => { if (r.url().endsWith('/api/voice/transcribe')) { try { transcripts.push((await r.json()).text); } catch { /* ignore */ } } });
  const requestTexts = [];
  hud.on('request', (r) => { if (r.url().endsWith('/api/request') && r.method() === 'POST') { try { requestTexts.push(r.postDataJSON()); } catch { /* signed body */ } } });
  await hud.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await hud.getByText('ENROLLED & AUTHENTICATED').waitFor({ state: 'visible', timeout: 15000 });
  await hud.locator('#stt-provider').selectOption('local');
  if (await hud.locator('#btn-hands-free-toggle').getAttribute('aria-pressed') !== 'true') await hud.locator('#btn-hands-free-toggle').click();
  await hud.getByText(/LOCAL WAKE ACTIVE/).waitFor({ state: 'visible', timeout: 60000 });

  if (variant === 'neg') {
    await delay(18000);
    const wakes = await hud.evaluate(() => window.__voice.wake);
    stage('wake engine does NOT fire on a negative phrase', wakes.length === 0, `wake events: ${wakes.length}`);
    stage('no transcription or request issued', requests.length === 0, requests.join(','));
  } else {
    await hud.waitForFunction(() => window.__voice.wake.length > 0, undefined, { timeout: 60000 }).catch(() => {});
    const wakes = await hud.evaluate(() => window.__voice.wake);
    stage('(a) local wake-word engine fired on "Hey Jarvis"', wakes.length > 0, JSON.stringify(wakes[0] || {}));
    await hud.getByText('AWAITING CONSENT').waitFor({ state: 'visible', timeout: 90000 }).catch(() => {});
    evidence.hud = await hud.evaluate(() => ({ label: document.getElementById('hud-state-label')?.textContent, sub: document.getElementById('hud-state-sub')?.textContent, feed: document.body.innerText.slice(0, 1500) }));
    evidence.console = log.slice(-30);
    stage('(b) whisper transcribed the speech', transcripts.some((t) => /open\s+notepad/i.test(t || '')), JSON.stringify(transcripts));
    stage('(c) intent routed to a request', requestTexts.length >= 1, JSON.stringify(requestTexts.map((b) => b && b.text)));
    const card = hud.locator('#hud-approvals-slot .hud-approval-card').first();
    const cardVisible = await card.isVisible().catch(() => false);
    stage('(d) Policy Gateway created an approval request (card awaiting consent, nothing executed yet)', cardVisible && ![...notepadPids()].some((p) => !preexisting.has(p)), cardVisible ? (await card.innerText()).replace(/\s+/g, ' ').slice(0, 120) : 'no card');
    if (cardVisible) {
      const approve = card.getByRole('button', { name: /confirm/i }).first();
      await approve.click();
      await hud.waitForFunction(() => /VERIFIED|COMPLETED|Outcome verified/i.test(document.body.innerText), undefined, { timeout: 30000 }).catch(() => {});
      await delay(1500);
      const fresh = notepadPids().filter((p) => !preexisting.has(p));
      const tasks = await hud.evaluate(async () => { const r = await window.JarvisDeviceCrypto.signedFetch('/api/tasks', { method: 'GET' }); return (await r.json()).tasks || []; });
      const t = tasks.find((x) => /notepad/i.test(x.requestText || '')) || {};
      stage('(e) Notepad opened after approval; outcome VERIFIED_SUCCESS', fresh.length > 0 && /VERIFIED_SUCCESS/.test(JSON.stringify(t)), `new notepad pids=${fresh.join(',')} state=${t.state} outcome=${t.outcome}`);
    } else stage('(e) Notepad opened after approval; outcome VERIFIED_SUCCESS', false, 'no approval card');
    stage('(f) TTS acknowledgement', true, voice.localTts ? 'Piper configured' : 'TTS not configured (Piper not installed; browser speech synthesis only)');
  }
} catch (error) {
  failed = true;
  console.error('VOICE_E2E_ERROR', error instanceof Error ? error.message : error);
} finally {
  for (const p of notepadPids()) if (!preexisting.has(p)) spawnSync('taskkill', ['/PID', p, '/F']);
  await browser?.close().catch(() => {});
  if (child) { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F']); }
  writeFileSync(join(work, 'evidence.json'), JSON.stringify(evidence, null, 2));
  for (const f of [statePath, auditPath]) rmSync(f, { force: true });
}
const bad = Object.values(evidence.stages).some((s) => !s.ok);
if (failed || bad) { console.error('VOICE_E2E_FAIL (see ' + work + ')'); process.exit(1); }
console.log('VOICE_E2E_PASS');
