import { spawn } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright-core';

const port = 3998;
const ownerToken = 'browser-e2e-owner-token-2026-0123456789abcdef';
const stamp = String(Date.now());
const statePath = `./data/browser-smoke-devices-${stamp}.json`;
const auditPath = `./data/browser-smoke-audit-${stamp}.log`;
const baseUrl = `http://127.0.0.1:${port}`;
const browserCandidates = [
  process.env.EDGE_PATH,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean);
const edgePath = browserCandidates.find((candidate) => existsSync(candidate));
if (!edgePath) throw new Error('Microsoft Edge executable was not found on the Windows CI runner');

let stdout = '';
let stderr = '';
let child;
let browser;

async function waitForServer() {
  for (let attempt = 0; attempt < 60; attempt++) {
    if (child.exitCode !== null) throw new Error(`JARVIS server exited early.\n${stdout}\n${stderr}`);
    try {
      const response = await fetch(`${baseUrl}/api/status`);
      if (response.ok) return;
    } catch {
      // Wait for the local server to bind.
    }
    await delay(250);
  }
  throw new Error(`JARVIS server did not become ready.\n${stdout}\n${stderr}`);
}

try {
  for (const path of [statePath, auditPath]) {
    if (existsSync(path)) rmSync(path, { force: true });
  }

  child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      JARVIS_OWNER_CONTROL_TOKEN: ownerToken,
      JARVIS_DEVICE_STATE_PATH: statePath,
      JARVIS_AUDIT_PATH: auditPath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  await waitForServer();

  browser = await chromium.launch({
    executablePath: edgePath,
    headless: true,
    args: ['--disable-gpu', '--no-first-run', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
  });
  const context = await browser.newContext();
  const pageErrors = [];
  const consoleErrors = [];
  let expectedUnauthorizedRequest = false;
  let expectedUnauthorizedConsoleErrors = 0;
  const auditRequests = [];
  const page = await context.newPage();
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/audit') auditRequests.push(request.url());
  });
  page.on('console', (message) => {
    if (message.type() !== 'error' || message.text().toLowerCase().includes('favicon.ico')) return;
    if (message.text().startsWith('INFO: Created TensorFlow Lite XNNPACK delegate for CPU.')) return;
    if (expectedUnauthorizedRequest && message.text().includes('401 (Unauthorized)')) {
      expectedUnauthorizedConsoleErrors++;
    } else {
      consoleErrors.push(message.text());
    }
  });

  await page.goto(`${baseUrl}/companion`, { waitUntil: 'domcontentloaded' });
  page.on('dialog', async (dialog) => {
    if (dialog.type() === 'prompt') await dialog.accept(ownerToken);
    else await dialog.dismiss();
  });

  // Owner-authorized challenge -> Ed25519 proof-of-possession enrollment -> signed session.
  await page.locator('#btn-enroll-browser').click();
  try {
    await page.locator('#enrollment-registered').waitFor({ state: 'visible', timeout: 15000 });
  } catch {
    throw new Error(`Browser enrollment failed: ${await page.locator('#tasks-feed').innerText()}`);
  }
  if (!(await page.locator('#header-device-name').innerText()).includes('JARVIS Browser Companion')) {
    throw new Error('Browser enrollment did not update the device identity UI');
  }

  // Verify a signed read-only API request returns a completed result.
  await page.locator('#input-request').fill('What is the OS version?');
  await page.locator('#btn-send-request').click();
  await page.waitForFunction(() => document.getElementById('tasks-feed')?.innerText.includes(
    'Outcome verified: Operation outcome successfully verified (system:get_os_info)',
  ));

  // Verify untrusted markup stays text-only inside a real approval card.
  await page.locator('#input-request').fill('Please launch Notepad <img src=x onerror=window.__xss=1>');
  await page.locator('#btn-send-request').click();
  const approval = page.locator('#approvals-container .approval-card').first();
  try {
    await approval.waitFor({ state: 'visible', timeout: 10000 });
  } catch {
    throw new Error(`Expected approval card after an allowlisted launch request. Companion feed: ${await page.locator('#tasks-feed').innerText()}`);
  }
  const injectedImages = await page.locator('#approvals-container img').count();
  const xssExecuted = await page.evaluate(() => window.__xss === 1);
  if (injectedImages !== 0 || xssExecuted) throw new Error('Potential DOM XSS in approval rendering');
  await approval.getByRole('button', { name: 'Deny / Reject' }).click();
  await approval.waitFor({ state: 'detached', timeout: 10000 });

  // Open the HUD in a second tab: it must establish its own signed session from
  // the stored non-extractable device key, then accept text fallback directives.
  // The speech API mock exercises browser event handling only, not microphone hardware.
  await context.addInitScript(() => {
    window.__mockRecognizers = [];
    class MockSpeechRecognition {
      constructor() {
        window.__mockRecognizers.push(this);
      }
      start() {
        this.onstart?.();
      }
      stop() {
        this.onend?.();
      }
      abort() {
        this.onend?.();
      }
    }
    Object.defineProperty(window, 'SpeechRecognition', { configurable: true, value: MockSpeechRecognition });
    Object.defineProperty(window, 'webkitSpeechRecognition', { configurable: true, value: MockSpeechRecognition });
    const nativeSetTimeout = window.setTimeout.bind(window);
    window.setTimeout = (callback, milliseconds, ...args) =>
      nativeSetTimeout(callback, milliseconds === 15000 ? 5000 : milliseconds, ...args);
  });
  const hud = await context.newPage();
  hud.on('pageerror', (error) => pageErrors.push(error.message));
  hud.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/audit') auditRequests.push(request.url());
  });
  hud.on('console', (message) => {
    if (message.type() !== 'error') return;
    if (message.text().startsWith('INFO: Created TensorFlow Lite XNNPACK delegate for CPU.')) return;
    if (expectedUnauthorizedRequest && message.text().includes('401 (Unauthorized)')) {
      expectedUnauthorizedConsoleErrors++;
    } else {
      consoleErrors.push(message.text());
    }
  });
  await hud.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await hud.getByText('ENROLLED & AUTHENTICATED').waitFor({ state: 'visible', timeout: 10000 });
  let hudRequestCount = 0;
  await hud.route('**/api/request', async (route) => {
    hudRequestCount++;
    await delay(250);
    await route.continue();
  });
  await hud.locator('#hud-text-input').fill('Check system memory and RAM');
  await hud.locator('#btn-hud-send').click();
  await hud.locator('#btn-hud-send').dispatchEvent('click');
  await hud.locator('#hud-tasks-feed .success').first().waitFor({ state: 'visible', timeout: 10000 });
  if (hudRequestCount !== 1) throw new Error(`Duplicate submit guard allowed ${hudRequestCount} requests`);
  if (!(await hud.locator('#hud-tasks-feed').innerText()).includes('totalBytes')) {
    throw new Error('System memory request did not return memory evidence through the primary UI');
  }
  await hud.unroute('**/api/request');

  await hud.route('**/api/request', (route) => route.fulfill({
    status: 401,
    contentType: 'application/json',
    body: JSON.stringify({ error: 'Session expired; establish a new signed session.' }),
  }));
  expectedUnauthorizedRequest = true;
  await hud.locator('#hud-text-input').fill('Check memory after session expiry');
  await hud.locator('#btn-hud-send').click();
  await hud.waitForFunction(() => document.getElementById('hud-state-sub')?.textContent?.includes(
    'HTTP 401: Session expired; establish a new signed session.',
  ));
  if (await hud.locator('#hud-text-input').inputValue() !== 'Check memory after session expiry') {
    throw new Error('A failed request cleared the user input instead of preserving it for recovery');
  }
  await hud.unroute('**/api/request');
  expectedUnauthorizedRequest = false;
  if (expectedUnauthorizedConsoleErrors !== 1) {
    throw new Error(`Expected one browser console notice for the deliberate HTTP 401 response, observed ${expectedUnauthorizedConsoleErrors}`);
  }

  // An ambiguous approval result must never be presented as verified success.
  await hud.locator('#hud-text-input').fill('Please launch Notepad');
  await hud.locator('#btn-hud-send').click();
  const hudApproval = hud.locator('#hud-approvals-slot .hud-approval-card').first();
  await hudApproval.waitFor({ state: 'visible', timeout: 10000 });
  await hud.route('**/api/approval/approve', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      success: false,
      state: 'COMPLETED',
      outcome: 'UNCERTAIN',
      verified: false,
      message: 'Execution evidence is unavailable',
    }),
  }));
  await hudApproval.getByRole('button', { name: 'CONFIRM & EXECUTE' }).click();
  await hud.getByText('APPROVAL PROCESSED — NOT COMPLETE').waitFor({ state: 'visible' });
  if (await hud.locator('#hud-tasks-feed .success').count() !== 1) {
    throw new Error('An uncertain approval result was presented as verified success');
  }
  await hud.unroute('**/api/approval/approve');

  // Click-to-toggle voice capture must stay open after the initiating click.
  const ptt = hud.locator('#btn-ptt');
  await ptt.click();
  await hud.waitForFunction(() => window.__mockRecognizers.length === 1, null, { timeout: 3000 });
  const listeningState = await hud.locator('#hud-state-label').innerText();
  if (listeningState !== 'LISTENING...') throw new Error(`Push-to-talk did not enter LISTENING state: ${listeningState}`);
  await hud.evaluate(() => window.__mockRecognizers[0].onresult({
    results: [[{ transcript: 'cancel this directive' }]],
  }));
  await hud.locator('#transcript-box').waitFor({ state: 'visible' });
  await hud.keyboard.press('Escape');
  await hud.evaluate(() => window.__mockRecognizers[0].onresult({
    results: [[{ transcript: 'late canceled directive' }]],
  }));
  if (await hud.locator('#transcript-input').inputValue() !== '' ||
      await hud.locator('#transcript-box').isVisible()) {
    throw new Error('A canceled voice capture exposed a stale transcript');
  }

  // The explicit Discard action clears an editable transcript.
  await ptt.click();
  await hud.waitForFunction(() => window.__mockRecognizers.length === 2, null, { timeout: 3000 });
  await hud.evaluate(() => window.__mockRecognizers[1].onresult({
    results: [[{ transcript: 'discard this directive' }]],
  }));
  await hud.locator('#transcript-box').waitFor({ state: 'visible' });
  await ptt.click();
  await hud.locator('#btn-transcript-cancel').click();
  if (await hud.locator('#transcript-input').inputValue() !== '' ||
      await hud.locator('#transcript-box').isVisible()) {
    throw new Error('The transcript Discard action retained captured text');
  }

  // Ctrl+M toggles push-to-talk without intercepting space in an editable field.
  await hud.evaluate(() => document.activeElement?.blur());
  await hud.keyboard.press('Control+m');
  await hud.waitForFunction(() => window.__mockRecognizers.length === 3, null, { timeout: 3000 });
  await hud.keyboard.press('Control+m');
  await hud.locator('#hud-text-input').focus();
  await hud.keyboard.press('Space');
  if (await hud.evaluate(() => window.__mockRecognizers.length) !== 3) {
    throw new Error('Space in the text field unexpectedly started voice capture');
  }

  // The 15-second capture bound stops recognition and remains visible to the user.
  await ptt.click();
  await hud.getByText('VOICE TIME LIMIT').waitFor({ state: 'visible', timeout: 7000 });
  await ptt.click();

  // Browser permission failure is explicit, releases the capture state, and leaves text available.
  const recognizerCount = await hud.evaluate(() => window.__mockRecognizers.length);
  await ptt.click();
  await hud.waitForFunction((count) => window.__mockRecognizers.length === count + 1, recognizerCount, { timeout: 3000 });
  await hud.evaluate((index) => window.__mockRecognizers[index].onerror({ error: 'not-allowed' }), recognizerCount);
  await hud.getByText('MICROPHONE PERMISSION REQUIRED').waitFor({ state: 'visible' });
  await hud.getByText('Allow microphone access for this site in browser settings, then retry voice input.').waitFor({ state: 'visible' });

  await hud.locator('#btn-toggle-motion').click();

  // The camera remains off until the user explicitly enables it. This uses
  // Chromium's fake camera device and is lifecycle coverage, not physical-camera acceptance.
  await context.grantPermissions(['camera'], { origin: baseUrl });
  if (await hud.locator('#camera-indicator').innerText() !== 'CAMERA OFF' ||
      await hud.locator('#btn-camera-toggle').getAttribute('aria-pressed') !== 'false') {
    throw new Error('Camera was not visibly off by default');
  }
  const externalGestureRequests = [];
  const gestureRuntimeRequests = [];
  hud.on('request', (request) => {
    const url = new URL(request.url());
    if (url.origin !== baseUrl) externalGestureRequests.push(request.url());
    if (url.pathname.startsWith('/gesture/') || url.pathname.includes('gesture-')) gestureRuntimeRequests.push(url.pathname);
  });
  hud.on('response', (response) => {
    const url = new URL(response.url());
    if (url.pathname.startsWith('/gesture/') || url.pathname.includes('gesture-')) {
      gestureRuntimeRequests.push(`${response.status()} ${url.pathname}`);
    }
  });
  await hud.locator('#btn-camera-toggle').click();
  try {
    await hud.waitForFunction(() => {
      const camera = document.getElementById('camera-indicator')?.textContent || '';
      const status = document.getElementById('gesture-status')?.textContent || '';
      return camera.includes('CAMERA ACTIVE') &&
        (status === 'CAMERA ACTIVE — local hand tracking ready' || status.startsWith('NO HAND DETECTED') || status.startsWith('LOCAL TRACKING'));
    }, null, { timeout: 20000 });
  } catch {
    throw new Error(`Local hand tracker did not become ready: ${await hud.locator('#gesture-status').innerText()}; requests=${JSON.stringify(gestureRuntimeRequests)}; pageErrors=${JSON.stringify(pageErrors)}`);
  }
  const cameraActive = await hud.evaluate(() => {
    const video = document.getElementById('gesture-video');
    return {
      active: video.srcObject?.active === true,
      audioTracks: video.srcObject?.getAudioTracks().length ?? -1,
      hasVideoTrack: video.srcObject?.getVideoTracks().length === 1,
      indicator: document.getElementById('camera-indicator').textContent,
    };
  });
  if (!cameraActive.active || cameraActive.audioTracks !== 0 || !cameraActive.hasVideoTrack ||
      !cameraActive.indicator.includes('CAMERA ACTIVE')) {
    throw new Error(`Camera stream did not meet video-only active-state requirements: ${JSON.stringify(cameraActive)}`);
  }
  await hud.evaluate(() => { window.__jarvisCameraTrack = document.getElementById('gesture-video').srcObject.getVideoTracks()[0]; });
  await hud.locator('#btn-camera-toggle').click();
  const cameraReleased = await hud.evaluate(() => ({
    detached: document.getElementById('gesture-video').srcObject === null,
    ended: window.__jarvisCameraTrack.readyState === 'ended',
    pressed: document.getElementById('btn-camera-toggle').getAttribute('aria-pressed'),
  }));
  if (!cameraReleased.detached || !cameraReleased.ended || cameraReleased.pressed !== 'false') {
    throw new Error(`Camera stop did not stop every track and detach the stream: ${JSON.stringify(cameraReleased)}`);
  }
  await hud.locator('#btn-camera-toggle').click();
  await hud.waitForFunction(() => {
    const camera = document.getElementById('camera-indicator')?.textContent || '';
    const status = document.getElementById('gesture-status')?.textContent || '';
    return camera.includes('CAMERA ACTIVE') &&
      (status === 'CAMERA ACTIVE — local hand tracking ready' || status.startsWith('NO HAND DETECTED') || status.startsWith('LOCAL TRACKING'));
  }, null, { timeout: 20000 });
  await hud.evaluate(() => document.getElementById('gesture-video').srcObject.getVideoTracks()[0].dispatchEvent(new Event('ended')));
  await hud.getByText('CAMERA LOST — released').waitFor({ state: 'visible', timeout: 5000 });
  if (await hud.locator('#camera-indicator').innerText() !== 'CAMERA OFF') {
    throw new Error('Camera loss did not clear the persistent active indicator');
  }
  const denied = await context.newPage();
  await denied.addInitScript(() => {
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      configurable: true,
      value: async () => { throw new DOMException('blocked by test fixture', 'NotAllowedError'); },
    });
  });
  await denied.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await denied.locator('#btn-camera-toggle').click();
  await denied.getByText('CAMERA PERMISSION DENIED — camera remains off').waitFor({ state: 'visible', timeout: 5000 });
  if (await denied.locator('#btn-camera-toggle').getAttribute('aria-pressed') !== 'false') {
    throw new Error('Camera permission denial left the UI in an active state');
  }
  await denied.close();
  if (externalGestureRequests.length) {
    throw new Error(`Gesture runtime attempted external network requests: ${externalGestureRequests.join(', ')}`);
  }
  if (await hud.locator('body').getAttribute('class').then((value) => !value.includes('reduced-motion'))) {
    throw new Error('Reduced-motion control did not activate');
  }
  await hud.locator('#btn-toggle-motion').click();

  await hud.waitForTimeout(4200);
  if (auditRequests.length) throw new Error('A device without DEVICE_MANAGE permission polled privileged audit data');
  const expectedRecognitionErrors = consoleErrors.filter((message) => message === 'Speech recognition error: not-allowed');
  const unexpectedConsoleErrors = consoleErrors.filter((message) => message !== 'Speech recognition error: not-allowed');
  if (pageErrors.length || unexpectedConsoleErrors.length || expectedRecognitionErrors.length !== 1) {
    throw new Error(`Browser runtime errors:\nPage errors: ${pageErrors.join(' | ')}\nUnexpected console errors: ${unexpectedConsoleErrors.join(' | ')}\nExpected permission error count: ${expectedRecognitionErrors.length}`);
  }

  const insecurePage = await context.newPage();
  await insecurePage.addInitScript(() => {
    Object.defineProperty(window, 'isSecureContext', { configurable: true, value: false });
  });
  await insecurePage.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await insecurePage.getByText('SECURE CONTEXT REQUIRED').waitFor({ state: 'visible' });
  await insecurePage.locator('#hud-text-input').fill('Text remains available without a secure voice context');
  if (!(await insecurePage.locator('#hud-text-input').isVisible())) {
    throw new Error('Text fallback was hidden in an insecure context');
  }
  await insecurePage.close();

  console.log('BROWSER_E2E_PASS: primary HUD routing, owner challenge, Ed25519 enrollment, signed requests, duplicate submission guard, expired-session error rendering, XSS regression, approval rejection, uncertain-outcome UI, HUD session restore, text fallback, insecure-context voice restriction, voice cancel/discard/late-result/timeout/permission-error/keyboard UI lifecycle, reduced motion, least-privilege audit polling, default-off camera, fake-device video-only stream, local model/WASM load, camera stop/release, simulated camera loss, simulated permission denial, no external gesture asset requests.');
} catch (error) {
  console.error('BROWSER_E2E_FAIL', error);
  console.error(stdout);
  console.error(stderr);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close().catch(() => {});
  if (child && child.exitCode === null) {
    child.kill();
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      delay(3000),
    ]);
  }
  for (const path of [statePath, auditPath, `${statePath}.tmp`, `${auditPath}.tmp`]) {
    if (existsSync(path)) rmSync(path, { force: true });
  }
}
