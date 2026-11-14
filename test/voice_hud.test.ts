import { test, describe, beforeEach, afterEach } from 'node:test';
import { freePort } from './helpers/freePort.js';
import assert from 'node:assert';
import { VoiceManager, SpeechState } from '../src/voice/voiceManager.ts';
import { JarvisServer } from '../src/server/server.ts';
import { rmSync, existsSync, readFileSync } from 'node:fs';

const TEST_AUDIT_LOG = `./data/test_voice_audit_${process.pid}.log`;
const TEST_PORT = await freePort();

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
    assert.match(hudHtml, /Browser speech recognition may send command audio to a browser\/vendor service/i);
    assert.match(hudHtml, /allow-browser-speech/);
    assert.match(hudHtml, /Hands-free wake listening stays off until a local audio wake-word engine is installed/i);
    assert.match(hudHtml, /allow-wake-browser-speech/);
    assert.doesNotMatch(hudHtml, /onclick=/i);
    assert.match(hudHtml, /waveform-canvas/);
    assert.match(hudHtml, /allow-wake-browser-speech/);

    const setupScript = readFileSync('scripts/setup-local-wake-word.ps1', 'utf8');
    assert.match(setupScript, /onnxruntime-web@1\.20\.1/);
    assert.match(setupScript, /npm ci --prefix \$runtimeRoot/);
    assert.match(setupScript, /package-lock\.json/);
    assert.match(setupScript, /multi_jarvis_v9\.3\.zip/);
    assert.match(setupScript, /8002ba9a14d80c0f71447920d3f1c8ee986b1432/);
    assert.match(setupScript, /a33f24ebcb89532478f15ba9e3b33bb8aa165a23/);
    assert.match(setupScript, /a3a60354eebe5fa4c7c9534851e4cb0bd7b0d06c/);
    assert.match(setupScript, /12d92a59869d7a1228761eb7127b930e5f568a6e/);
    assert.match(setupScript, /pinned Git blob integrity verification/);
    assert.doesNotMatch(setupScript, /raw\.githubusercontent\.com\/voicute\/onnx-wakeword\/main\//);
    const unapprovedWakeAsset = await fetch(`http://127.0.0.1:${TEST_PORT}/hud/local-wakeword/private.env`);
    assert.strictEqual(unapprovedWakeAsset.status, 404);
    assert.match(await unapprovedWakeAsset.text(), /asset not found/i);
    // The HUD checks installation through this endpoint instead of probing files (no console 404s).
    const wakeStatus = await fetch(`http://127.0.0.1:${TEST_PORT}/hud/local-wakeword/status`);
    assert.strictEqual(wakeStatus.status, 200);
    const wakeStatusBody = await wakeStatus.json() as { installed: unknown; setup?: string };
    assert.strictEqual(typeof wakeStatusBody.installed, 'boolean');
    if (!wakeStatusBody.installed) assert.match(String(wakeStatusBody.setup), /setup-local-wake-word\.ps1/);

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
    // Local wake timeout must not include browser microphone permission/audio-graph setup.
    const audioGraphReady = jsText.indexOf('processor.connect(context.destination);');
    const wakeWindowStart = jsText.indexOf('watchdog = setInterval', audioGraphReady);
    assert.ok(audioGraphReady >= 0 && wakeWindowStart > audioGraphReady,
      'local wake capture timeout starts only after the microphone audio graph is ready');
    assert.match(jsText, /MICROPHONE UNAVAILABLE/);
    assert.match(jsText, /SPEECH SERVICE UNAVAILABLE/);
    assert.match(jsText, /describeSpeechRecognitionError/);
    // Finalized segments are appended and bounded before review/dispatch.
    assert.match(jsText, /if \(result\.isFinal\) \{/);
    assert.match(jsText, /finalTranscript = `\$\{finalTranscript\} \$\{segment\}`\.trim\(\)\.slice\(0, MAX_VOICE_TRANSCRIPT_LENGTH\)/);
    assert.match(jsText, /filter\(\(result\) => !result\.isFinal\)/);
    assert.match(jsText, /Review or edit the recognized command, then select EXECUTE DIRECTIVE/);
    assert.match(jsText, /VOICE CONSENT REQUIRED/);
    assert.match(jsText, /LOCAL WAKE WORD UNAVAILABLE/);
    assert.match(jsText, /VoicuteWakeWord\.create/);
    assert.match(jsText, /multi_jarvis_v9\.3\.zip/);
    // Push-to-talk is review-first; consented post-wake capture dispatches through the policy gateway.
    assert.match(jsText, /Push-to-talk remains review-first/);
    assert.match(jsText, /JarvisDeviceCrypto\.signedFetch/);
    assert.match(jsText, /SESSION UNAVAILABLE — DIRECTIVE NOT SENT/);
    assert.match(jsText, /A retried response must not create duplicate controls/);
    assert.match(jsText, /const directive = existing\.querySelector\('\.hud-approval-directive'\)/);
    assert.match(jsText, /directive\.textContent = 'DIRECTIVE: ' \+ String\(requestText\)/);
    assert.match(jsText, /card.setAttribute\('role', 'region'\)/);
    assert.match(jsText, /card.focus\(\)/);
    assert.match(jsText, /Confirm and execute this exact directive/);
    assert.match(jsText, /function syncPendingApprovalCards\(tasks\)/);
    assert.match(jsText, /syncPendingApprovalCards\(tasks\)/);
    assert.match(jsText, /AWAITING_APPROVAL/);
    assert.match(jsText, /This task is still awaiting your explicit approval/);
    const serverSource = readFileSync('src/server/server.ts', 'utf8');
    assert.match(serverSource, /task\.state === TaskState\.AWAITING_APPROVAL && task\.approvalId/);
    assert.match(serverSource, /requestText: task\.requestText/);
    assert.match(jsText, /No authenticated device session; the request never reached the policy gateway/);
    assert.match(jsText, /speakResponse\(message\)/);
    assert.match(jsText, /15000/);
    assert.match(jsText, /discardVoiceResult/);
    assert.match(jsText, /function hasSpeechConsent\(mode\)/);
    assert.match(jsText, /function revokeSpeechConsent\(mode\)/);
    assert.match(jsText, /if \(activeVoiceCaptureMode !== mode\) return;/);
    assert.match(jsText, /pushToTalkConsent\?\.addEventListener\('change'/);
    assert.match(jsText, /wakeSpeechConsent\?\.addEventListener\('change'/);
    assert.match(jsText, /if \(!hasSpeechConsent\(mode\)\)\s*\{\s*revokeSpeechConsent\(mode\);/);
    assert.match(jsText, /VOICE CONSENT REVOKED — COMMAND NOT SENT/);
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
