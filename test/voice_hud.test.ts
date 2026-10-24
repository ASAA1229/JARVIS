import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { VoiceManager, SpeechState } from '../src/voice/voiceManager.ts';
import { JarvisServer } from '../src/server/server.ts';
import { rmSync, existsSync } from 'node:fs';

const TEST_AUDIT_LOG = './data/test_voice_audit.log';
const TEST_PORT = 3988;

describe('JARVIS Milestone 7: Voice Privacy, Push-to-Talk Lifecycle & HUD Routing', () => {
  let voiceManager: VoiceManager;
  let server: JarvisServer;

  beforeEach(async () => {
    if (existsSync(TEST_AUDIT_LOG)) rmSync(TEST_AUDIT_LOG, { force: true });
    voiceManager = new VoiceManager();
    server = new JarvisServer(TEST_PORT, TEST_AUDIT_LOG);
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
    if (existsSync(TEST_AUDIT_LOG)) rmSync(TEST_AUDIT_LOG, { force: true });
  });

  test('VOICE-01: Privacy guarantee — no continuous capture or wake-word by default', () => {
    assert.strictEqual(voiceManager.policy.continuousListeningAllowed, false);
    assert.strictEqual(voiceManager.policy.wakeWordEnabled, false);
    assert.strictEqual(voiceManager.getState(), SpeechState.IDLE);
    assert.strictEqual(voiceManager.getIsMuted(), false);
  });

  test('VOICE-02: Push-to-talk activation and transcript lifecycle', () => {
    // 1. Activate push-to-talk
    const startRes = voiceManager.startPushToTalk();
    assert.strictEqual(startRes.allowed, true);
    assert.strictEqual(voiceManager.getState(), SpeechState.LISTENING);

    // 2. Transcribe voice input
    voiceManager.updateTranscript('What is the OS version?');
    assert.strictEqual(voiceManager.getCurrentTranscript(), 'What is the OS version?');

    // 3. Stop capture moves to CONFIRMING state
    voiceManager.stopPushToTalk();
    assert.strictEqual(voiceManager.getState(), SpeechState.CONFIRMING);
  });

  test('VOICE-03: Mute privacy control halts capture and refuses start', () => {
    // Enable privacy mute
    const isMuted = voiceManager.toggleMute();
    assert.strictEqual(isMuted, true);
    assert.strictEqual(voiceManager.getState(), SpeechState.DISABLED);

    // Attempting push-to-talk while muted must be denied
    const startRes = voiceManager.startPushToTalk();
    assert.strictEqual(startRes.allowed, false);
    assert.match(startRes.reason || '', /muted by user privacy/);
  });

  test('VOICE-04: Cancellation discards in-flight transcript immediately', () => {
    voiceManager.startPushToTalk();
    voiceManager.updateTranscript('Launch Notepad');
    voiceManager.cancelCapture();

    assert.strictEqual(voiceManager.getState(), SpeechState.IDLE);
    assert.strictEqual(voiceManager.getCurrentTranscript(), '');
  });

  test('HUD-01: Server serves Cinematic HUD assets at /hud endpoint', async () => {
    const rootRes = await fetch(`http://127.0.0.1:${TEST_PORT}/`);
    assert.strictEqual(rootRes.status, 200);
    const rootHtml = await rootRes.text();
    assert.match(rootHtml, /btn-ptt/);
    assert.match(rootHtml, /btn-toggle-mic-mute/);
    assert.doesNotMatch(rootHtml, /Pixel Companion|dev-ed25519-bound|CHAIN OK/);

    const companionRes = await fetch(`http://127.0.0.1:${TEST_PORT}/companion`);
    assert.strictEqual(companionRes.status, 200);
    assert.match(await companionRes.text(), /btn-enroll-browser/);

    const cssResRoot = await fetch(`http://127.0.0.1:${TEST_PORT}/style.css`);
    assert.strictEqual(cssResRoot.status, 200);
    assert.ok((await cssResRoot.text()).length > 0);

    const challengeWithoutOwnerConfig = await fetch(`http://127.0.0.1:${TEST_PORT}/api/enrollment/challenge`, { method: 'POST' });
    assert.strictEqual(challengeWithoutOwnerConfig.status, 503);
    assert.strictEqual((await challengeWithoutOwnerConfig.json()).code, 'OWNER_CONTROL_NOT_CONFIGURED');

    const unknownRoute = await fetch(`http://127.0.0.1:${TEST_PORT}/no-such-route`);
    assert.strictEqual(unknownRoute.status, 404);
    const wrongMethod = await fetch(`http://127.0.0.1:${TEST_PORT}/api/request`);
    assert.strictEqual(wrongMethod.status, 404);

    // 1. Fetch HUD HTML
    const hudRes = await fetch(`http://127.0.0.1:${TEST_PORT}/hud`);
    assert.strictEqual(hudRes.status, 200);
    const hudHtml = await hudRes.text();
    const csp = hudRes.headers.get('content-security-policy') || '';
    assert.match(csp, /script-src 'self'/);
    assert.doesNotMatch(csp, /script-src[^;]*unsafe-inline/);
    assert.match(csp, /style-src 'self'/);
    assert.doesNotMatch(csp, /style-src[^;]*unsafe-inline/);
    assert.match(hudHtml, /J\.A\.R\.V\.I\.S\./);
    assert.match(hudHtml, /btn-arc-ptt/);
    assert.match(hudHtml, /local-only processing is not guaranteed/i);
    assert.doesNotMatch(hudHtml, /onclick=/i);
    assert.match(hudHtml, /waveform-canvas/);

    // 2. Fetch HUD CSS
    const cssRes = await fetch(`http://127.0.0.1:${TEST_PORT}/hud/hud.css`);
    assert.strictEqual(cssRes.status, 200);
    const cssText = await cssRes.text();
    assert.match(cssText, /reactor-inner-core/);

    // 3. Fetch HUD JS
    const jsRes = await fetch(`http://127.0.0.1:${TEST_PORT}/hud/hud.js`);
    assert.strictEqual(jsRes.status, 200);
    const jsText = await jsRes.text();
    assert.match(jsText, /initSpeechRecognition/);
    assert.match(jsText, /NO SPEECH DETECTED/);
    assert.match(jsText, /MICROPHONE UNAVAILABLE/);
    assert.match(jsText, /SPEECH SERVICE UNAVAILABLE/);
    assert.match(jsText, /describeSpeechRecognitionError/);
    assert.match(jsText, /finalized segments separate from interim hypotheses/);
    assert.match(jsText, /Analyzing the recognized command through the policy gateway/);
    assert.match(jsText, /JarvisDeviceCrypto\.signedFetch/);
    assert.match(jsText, /15000/);
    assert.match(jsText, /discardVoiceResult/);
    assert.doesNotMatch(jsText, /(?:card|item|entry)\.innerHTML\s*=/i);
    assert.doesNotMatch(jsText, /onclick=/i);
    const appRes = await fetch(`http://127.0.0.1:${TEST_PORT}/app.js`);
    assert.strictEqual(appRes.status, 200);
    const appJs = await appRes.text();
    assert.match(appJs, /JarvisDeviceCrypto\.signedFetch/);
    assert.doesNotMatch(appJs, /sess-simulated|simulated_sig|onclick=/i);
    assert.doesNotMatch(appJs, /(?:card|item|entry)\.innerHTML\s*=/i);
    assert.match(appJs, /task did not complete/i);

    const cryptoRes = await fetch(`http://127.0.0.1:${TEST_PORT}/deviceCrypto.js`);
    assert.strictEqual(cryptoRes.status, 200);
    const cryptoClient = await cryptoRes.text();
    assert.match(cryptoClient, /Ed25519/);
    assert.match(cryptoClient, /indexedDB/);
    assert.match(cryptoClient, /signedFetch/);
    assert.match(cryptoClient, /false, \['sign'\]/);
  });
});
