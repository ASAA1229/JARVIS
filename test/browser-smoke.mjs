import { spawn } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright-core';

const port = 3998;
const ownerToken = 'browser-e2e-owner-token-2026';
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
    args: ['--disable-gpu', '--no-first-run'],
  });
  const context = await browser.newContext();
  const pageErrors = [];
  const consoleErrors = [];
  const page = await context.newPage();
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error' && !message.text().toLowerCase().includes('favicon.ico')) consoleErrors.push(message.text());
  });

  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  page.on('dialog', async (dialog) => {
    if (dialog.type() === 'prompt') await dialog.accept(ownerToken);
    else await dialog.dismiss();
  });

  // Owner-authorized challenge -> Ed25519 proof-of-possession enrollment -> signed session.
  await page.locator('#btn-simulate-phone').click();
  await page.locator('#enrollment-registered').waitFor({ state: 'visible', timeout: 15000 });
  if (!(await page.locator('#header-device-name').innerText()).includes('JARVIS Browser Companion')) {
    throw new Error('Browser enrollment did not update the device identity UI');
  }

  // Verify a signed read-only API request returns a completed result.
  await page.locator('#input-request').fill('What is the OS version?');
  await page.locator('#btn-send-request').click();
  await page.locator('#tasks-feed .success').first().waitFor({ state: 'visible', timeout: 10000 });

  // Verify untrusted markup stays text-only inside a real approval card.
  await page.locator('#input-request').fill('Please launch Notepad <img src=x onerror=window.__xss=1>');
  await page.locator('#btn-send-request').click();
  const approval = page.locator('#approvals-container .approval-card').first();
  await approval.waitFor({ state: 'visible', timeout: 10000 });
  const injectedImages = await page.locator('#approvals-container img').count();
  const xssExecuted = await page.evaluate(() => window.__xss === 1);
  if (injectedImages !== 0 || xssExecuted) throw new Error('Potential DOM XSS in approval rendering');
  await approval.getByRole('button', { name: 'Deny / Reject' }).click();
  await approval.waitFor({ state: 'detached', timeout: 10000 });

  // Open the HUD in a second tab: it must establish its own signed session from
  // the stored non-extractable device key, then accept text fallback directives.
  const hud = await context.newPage();
  hud.on('pageerror', (error) => pageErrors.push(error.message));
  hud.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  await hud.goto(`${baseUrl}/hud`, { waitUntil: 'domcontentloaded' });
  await hud.getByText('ENROLLED & AUTHENTICATED').waitFor({ state: 'visible', timeout: 10000 });
  await hud.locator('#hud-text-input').fill('What is the OS version?');
  await hud.locator('#btn-hud-send').click();
  await hud.locator('#hud-tasks-feed .success').first().waitFor({ state: 'visible', timeout: 10000 });

  if (pageErrors.length || consoleErrors.length) {
    throw new Error(`Browser runtime errors:\nPage errors: ${pageErrors.join(' | ')}\nConsole errors: ${consoleErrors.join(' | ')}`);
  }

  console.log('BROWSER_E2E_PASS: owner challenge, Ed25519 enrollment, signed request, XSS regression, approval rejection, HUD session restore, text fallback.');
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
