// JARVIS Cinematic HUD & Push-To-Talk Engine
let currentDevice = null;
let currentSession = null;
let isMicMuted = false;
let isListening = false;
let speechRecognizer = null;
let speechRecognitionConstructor = null;
let speechUnavailableReason = '';
let audioContext = null;
let animationFrameId = null;
let voiceTimeoutId = null;
let discardVoiceResult = false;
let voiceCaptureGeneration = 0;
let isSubmitting = false;
let activeVoiceCaptureMode = null;
// Prevent duplicate submissions for a single-use approval.
const approvalResolutionsInFlight = new Set();
let isHandsFreeEnabled = false;
let isWaitingForWakeCommand = false;
let isSpeaking = false;
let speechOutputEnabled = true;
let speechSynthesisAvailable = 'speechSynthesis' in window;
let handsFreeEnabled = false;
let handsFreeStandby = false;
let handsFreeRecognizer = null;
let handsFreeRestartTimer = null;
let browserWakeRetryCount = 0;
const MAX_BROWSER_WAKE_RETRIES = 5;
let localTtsUnavailable = false;
let activeSpeechAudio = null;
let activeSpeechAudioUrl = null;
let activeSpeechCleanup = null;
let speechOutputGeneration = 0;
let localWakeEngine = null;
let localWakeAssetsPromise = null;
let localWakeStartPromise = null;
let localWakeLifecycleGeneration = 0;
let wakeCaptureAwaitingReview = false;
let wakeCommandRetryCount = 0;
const MAX_WAKE_COMMAND_RETRIES = 1;

const WAKE_PHRASES = ['hello jarvis', 'hi jarvis', 'hey jarvis', 'i am here', 'im here'];
const STOP_PHRASES = ['jarvis you may leave', 'jarvis you may leave now', 'stop jarvis', 'jarvis stop', 'goodbye jarvis', 'go to sleep jarvis'];

document.addEventListener('DOMContentLoaded', async () => {
  try { isMicMuted = localStorage.getItem('jarvis.mic-muted') === 'true'; } catch { /* Privacy controls remain session-local if storage is blocked. */ }
  initSpeechRecognition();
  setupEventListeners();
  updateHandsFreeButtons();
  updateMuteControl();
  initWaveformCanvas();
  await ensureEnrolledDevice();
  pollStatus();
  setInterval(pollStatus, 3000);
  setInterval(pollAudit, 4000);
});

function setupEventListeners() {
  const btnPtt = document.getElementById('btn-ptt');
  const btnSend = document.getElementById('btn-hud-send');
  const textInput = document.getElementById('hud-text-input');
  const btnMute = document.getElementById('btn-toggle-mic-mute');
  const btnHandsFreeToggle = document.getElementById('btn-hands-free-toggle');
  const btnHandsFreePause = document.getElementById('btn-hands-free-pause');
  const btnMotion = document.getElementById('btn-toggle-motion');
  const btnHandsFree = document.getElementById('btn-hands-free');
  const btnSpeech = document.getElementById('btn-speech-output');
  const pushToTalkConsent = document.getElementById('allow-browser-speech');
  const wakeSpeechConsent = document.getElementById('allow-wake-browser-speech');
  const reactorCore = document.getElementById('reactor-core');

  // Click-to-toggle voice capture: a normal click must not stop recognition immediately.
  const toggleVoiceCapture = () => {
    if (isListening) stopVoiceCapture();
    else startVoiceCapture();
  };
  pushToTalkConsent?.addEventListener('change', () => {
    if (!pushToTalkConsent.checked) revokeSpeechConsent('push-to-talk');
  });
  wakeSpeechConsent?.addEventListener('change', () => {
    if (!wakeSpeechConsent.checked) revokeSpeechConsent('wake');
  });

  btnPtt.addEventListener('click', toggleVoiceCapture);
  reactorCore.addEventListener('click', toggleVoiceCapture);
  reactorCore.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); toggleVoiceCapture(); }
  });

  // Keyboard shortcuts use the same toggle behavior as the on-screen control.
  window.addEventListener('keydown', (e) => {
    const activeElement = document.activeElement;
    const isEditable = activeElement instanceof HTMLElement &&
      (activeElement.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(activeElement.tagName));
    const isOtherButton = activeElement instanceof HTMLButtonElement && activeElement !== btnPtt;
    if (e.code === 'Space' && !e.repeat && !isEditable && !isOtherButton) {
      e.preventDefault();
      toggleVoiceCapture();
    }
    if (e.ctrlKey && e.key.toLowerCase() === 'm' && !e.repeat && !isEditable && !isOtherButton) {
      e.preventDefault();
      toggleVoiceCapture();
    }
    if (e.code === 'Escape' && isListening) cancelVoiceCapture();
  });

  // Send terminal text input
  btnSend.addEventListener('click', handleTextSubmit);
  textInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleTextSubmit();
  });

  // Transcript confirmation actions
  document.getElementById('btn-transcript-submit').addEventListener('click', () => {
    const transcriptInput = document.getElementById('transcript-input');
    const val = transcriptInput.value.trim();
    if (val) void submitDirective(val);
  });

  document.getElementById('btn-transcript-cancel').addEventListener('click', () => {
    cancelVoiceCapture();
  });

  if (btnHandsFree) btnHandsFree.addEventListener('click', () => {
    if (isHandsFreeEnabled) disableHandsFree();
    else enableHandsFree();
  });
  if (btnSpeech) btnSpeech.addEventListener('click', () => {
    speechOutputEnabled = !speechOutputEnabled;
    btnSpeech.setAttribute('aria-pressed', String(speechOutputEnabled));
    btnSpeech.textContent = speechOutputEnabled ? 'VOICE: ON' : 'VOICE: OFF';
    if (!speechOutputEnabled) cancelSpeechOutput();
    if (speechOutputEnabled) speakResponse('Voice responses enabled.');
  });

  // Privacy Mute Toggle
  btnMute.addEventListener('click', () => {
    isMicMuted = !isMicMuted;
    try { localStorage.setItem('jarvis.mic-muted', String(isMicMuted)); } catch { /* Keep the control usable without storage. */ }
    updateMuteControl();
    if (isMicMuted) {
      disableHandsFree();
      disableWakeDetection();
      cancelVoiceCapture();
      setAssistantState('PRIVACY MODE — MIC MUTED', 'Microphone hardware access disabled.');
    } else {
      setAssistantState('STANDBY', 'Microphone armed. Enable hands-free or use push-to-talk.');
    }
  });


  btnHandsFreeToggle.addEventListener('click', () => {
    if (!handsFreeEnabled) enableWakeDetection(); else disableWakeDetection();
  });

  btnHandsFreePause.addEventListener('click', () => {
    if (!handsFreeEnabled) {
      setAssistantState('HANDS-FREE DISABLED', 'Enable hands-free mode before resuming wake detection.');
      return;
    }
    if (handsFreeStandby) {
      handsFreeStandby = false;
      stopHandsFreeStandby();
      setAssistantState('LISTENING PAUSED', 'Wake detection paused. Resume to regain standby listening.');
      btnHandsFreePause.textContent = 'RESUME LISTENING';
      btnHandsFreePause.setAttribute('aria-pressed', 'false');
      return;
    }
    btnHandsFreePause.textContent = 'PAUSE LISTENING';
    btnHandsFreePause.setAttribute('aria-pressed', 'true');
    startLocalWakeEngine().catch((error) => {
      setAssistantState('LOCAL WAKE WORD UNAVAILABLE', error instanceof Error ? error.message : 'Could not restart local wake detection.');
      disableWakeDetection();
    });
  });

  // Revoking browser speech consent is immediate: discard the in-flight transcript and stop capture.
  const browserSpeechConsent = document.getElementById('allow-browser-speech');
  if (browserSpeechConsent) browserSpeechConsent.addEventListener('change', () => {
    if (!browserSpeechConsent.checked && isListening && !wakeCaptureAwaitingReview) {
      cancelVoiceCapture();
      setAssistantState('VOICE CONSENT REVOKED', 'Microphone capture stopped and the pending transcript was discarded. Re-enable consent only when you want to use browser speech.');
    }
  });
  const wakeSpeechConsent = document.getElementById('allow-wake-browser-speech');
  if (wakeSpeechConsent) wakeSpeechConsent.addEventListener('change', () => {
    if (!wakeSpeechConsent.checked && isListening && wakeCaptureAwaitingReview) {
      cancelVoiceCapture();
      setAssistantState('VOICE CONSENT REVOKED', 'Post-wake browser speech stopped and the pending transcript was discarded. Local wake detection can remain active.');
    }
  });

  // Never keep an active mic session alive after the HUD is backgrounded or hidden.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      if (isListening) {
        cancelVoiceCapture();
        setAssistantState('VOICE CAPTURE STOPPED', 'The HUD was hidden; microphone capture and the pending transcript were stopped.');
      }
      stopAudioMeter();
      if (handsFreeEnabled) {
        handsFreeStandby = false;
        stopHandsFreeStandby();
        updateHandsFreeButtons();
      }
    } else if (document.visibilityState === 'visible' && handsFreeEnabled && !isMicMuted) {
      scheduleHandsFreeRestart();
    }
  });

  // Reduced Motion Toggle
  btnMotion.addEventListener('click', () => {
    document.body.classList.toggle('reduced-motion');
    const isReduced = document.body.classList.contains('reduced-motion');
    btnMotion.innerText = `REDUCED MOTION: ${isReduced ? 'ON' : 'OFF'}`;
    btnMotion.setAttribute('aria-pressed', String(isReduced));
    if (!isReduced) initWaveformCanvas();
  });

  // Quick Directive Chips
  document.querySelectorAll('.hud-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const cmd = chip.getAttribute('data-cmd');
      textInput.value = cmd;
      void submitDirective(cmd);
    });
  });
}

function normalizeSpeechText(text) {
  return String(text || '').toLowerCase().replace(/['’]/g, '').replace(/[,!?;.:]/g, ' ').replace(/\s+/g, ' ').trim();
}

function textMatchesPhraseSet(text, phrases) {
  const normalized = normalizeSpeechText(text);
  if (!normalized) return false;
  // Match complete normalized phrases only. Substring matching can wake on
  // words such as “Jarvisian” or trigger a stop command inside another word.
  const boundedText = ` ${normalized} `;
  return phrases.some((phrase) => {
    const boundedPhrase = ` ${normalizeSpeechText(phrase)} `;
    return boundedText.includes(boundedPhrase);
  });
}

function isWakePhrase(text) {
  return textMatchesPhraseSet(text, WAKE_PHRASES);
}

function isStopPhrase(text) {
  return textMatchesPhraseSet(text, STOP_PHRASES);
}

function updateHandsFreeButtons() {
  const btnToggle = document.getElementById('btn-hands-free-toggle');
  const btnPause = document.getElementById('btn-hands-free-pause');
  if (!btnToggle || !btnPause) return;
  btnToggle.textContent = handsFreeEnabled ? 'DISABLE LOCAL WAKE' : 'ENABLE LOCAL WAKE';
  btnToggle.setAttribute('aria-pressed', String(handsFreeEnabled));
  const handsFreeButton = document.getElementById('btn-hands-free');
  if (handsFreeButton) {
    handsFreeButton.textContent = handsFreeEnabled ? 'HANDS-FREE CAPTURE: ON' : 'HANDS-FREE CAPTURE: OFF';
    handsFreeButton.setAttribute('aria-pressed', String(handsFreeEnabled));
  }
  const pauseLabel = handsFreeStandby ? 'PAUSE LISTENING' : 'RESUME LISTENING';
  btnPause.textContent = pauseLabel;
  btnPause.disabled = !handsFreeEnabled;
  btnPause.setAttribute('aria-pressed', String(handsFreeStandby));
}

async function loadLocalWakeWordAssets() {
  if (window.VoicuteWakeWord && window.ort && window.JSZip) return;
  if (localWakeAssetsPromise) return localWakeAssetsPromise;
  localWakeAssetsPromise = (async () => {
    const loadScript = (src) => new Promise((resolve, reject) => {
      const existing = Array.from(document.scripts).find((script) => script.src.endsWith(src));
      if (existing?.dataset.loaded === 'true') { resolve(); return; }
      const script = existing || document.createElement('script');
      const onLoad = () => { script.dataset.loaded = 'true'; resolve(); };
      const onError = () => reject(new Error('Local wake-word asset could not be loaded: ' + src));
      script.addEventListener('load', onLoad, { once: true });
      script.addEventListener('error', onError, { once: true });
      if (!existing) { script.src = src; script.async = false; document.head.appendChild(script); }
    });
    // Preflight script files with fetch so missing optional assets fail closed
    // without injecting broken script tags or generating browser console errors.
    for (const src of ['/hud/local-wakeword/ort.min.js', '/hud/local-wakeword/jszip.min.js', '/hud/local-wakeword/wakeword.js']) {
      const response = await fetch(src, { cache: 'no-store' });
      if (!response.ok) throw new Error('Local wake-word runtime assets are missing. Run scripts/setup-local-wake-word.ps1.');
    }
    await loadScript('/hud/local-wakeword/ort.min.js');
    await loadScript('/hud/local-wakeword/jszip.min.js');
    await loadScript('/hud/local-wakeword/wakeword.js');
    if (!window.VoicuteWakeWord || !window.ort || !window.JSZip) {
      throw new Error('Local wake-word runtime is incomplete. Run scripts/setup-local-wake-word.ps1.');
    }
    window.ort.env.wasm.wasmPaths = '/hud/local-wakeword/';
    window.ort.env.wasm.numThreads = 1;
  })();
  try { await localWakeAssetsPromise; }
  catch (error) { localWakeAssetsPromise = null; throw error; }
}

async function startLocalWakeEngine() {
  if (!handsFreeEnabled || isMicMuted || wakeCaptureAwaitingReview || document.visibilityState === 'hidden') return;
  if (localWakeEngine) return;
  if (localWakeStartPromise) return localWakeStartPromise;
  const lifecycleGeneration = localWakeLifecycleGeneration;
  localWakeStartPromise = (async () => {
    await loadLocalWakeWordAssets();
    if (lifecycleGeneration !== localWakeLifecycleGeneration || !handsFreeEnabled || isMicMuted || wakeCaptureAwaitingReview || document.visibilityState === 'hidden' || localWakeEngine) return;
    const engine = window.VoicuteWakeWord.create();
    try {
      await engine.load('/hud/local-wakeword/multi_jarvis_v9.3.zip', '/hud/local-wakeword/melspectrogram.onnx');
      // Loading can take several seconds; never start a microphone engine after
      // hands-free has been disabled, muted, or superseded by another lifecycle.
      if (lifecycleGeneration !== localWakeLifecycleGeneration || !handsFreeEnabled || isMicMuted || wakeCaptureAwaitingReview || document.visibilityState === 'hidden') {
        try { engine.stop(); } catch { /* release best-effort */ }
        return;
      }
      engine.setL1(true);
      engine.setL3(true);
      localWakeEngine = engine;
      await engine.start((word, probability) => {
        if (lifecycleGeneration !== localWakeLifecycleGeneration || localWakeEngine !== engine || !handsFreeEnabled || !handsFreeStandby || isSubmitting || isListening) return;
        if (String(word || '').toLowerCase().includes('jarvis')) {
          void handleLocalWakeDetected(Number(probability) || 0);
        }
      });
      if (lifecycleGeneration !== localWakeLifecycleGeneration || localWakeEngine !== engine || !handsFreeEnabled || isMicMuted || document.visibilityState === 'hidden') {
        try { engine.stop(); } catch { /* release best-effort */ }
        if (localWakeEngine === engine) localWakeEngine = null;
        return;
      }
      handsFreeStandby = true;
      updateHandsFreeButtons();
      setAssistantState('LOCAL WAKE ACTIVE', '“Hey Jarvis” is detected locally on this device. No wake audio is uploaded.');
    } catch (error) {
      try { engine.stop(); } catch { /* release best-effort */ }
      if (localWakeEngine === engine) localWakeEngine = null;
      throw error;
    }
  })();
  try { await localWakeStartPromise; }
  finally {
    localWakeStartPromise = null;
    // If the user re-enabled hands-free while an older start was unwinding,
    // give the new lifecycle a fresh start rather than leaving it stuck idle.
    if (handsFreeEnabled && !isMicMuted && !localWakeEngine && !wakeCaptureAwaitingReview && document.visibilityState !== 'hidden') {
      scheduleHandsFreeRestart();
    }
  }
}

function stopHandsFreeStandby() {
  localWakeLifecycleGeneration += 1;
  if (handsFreeRestartTimer) {
    clearTimeout(handsFreeRestartTimer);
    handsFreeRestartTimer = null;
  }
  if (handsFreeRecognizer) {
    try { handsFreeRecognizer.stop(); } catch (error) { /* no-op */ }
    handsFreeRecognizer = null;
  }
  if (localWakeEngine) {
    try { localWakeEngine.stop(); } catch (error) { /* no-op */ }
    localWakeEngine = null;
  }
  handsFreeStandby = false;
}

async function handleLocalWakeDetected(probability) {
  if (!handsFreeEnabled || !handsFreeStandby || isSubmitting || isListening) return;
  wakeCommandRetryCount = 0;
  handsFreeStandby = false;
  stopHandsFreeStandby();
  updateHandsFreeButtons();
  setAssistantState('WAKE PHRASE DETECTED', `Local “Hey Jarvis” detection succeeded (score ${Math.round(probability * 100)}%). Preparing command capture.`);
  const wakeConsent = document.getElementById('allow-wake-browser-speech');
  wakeCaptureAwaitingReview = Boolean(wakeConsent?.checked);
  if (!wakeConsent?.checked) {
    await speakResponse('Hi sir, I am ready to work.');
    setAssistantState('WAKE PHRASE DETECTED', 'Wake detection is local, but spoken commands need the separate post-wake browser-speech consent checkbox. Enable it for this session, or use text input.');
    scheduleHandsFreeRestart();
    return;
  }

  // Start command recognition immediately after local wake detection so the
  // remaining words in a single utterance such as “Hey Jarvis, open Notepad”
  // are not lost while the greeting is playing. The greeting is spoken after
  // capture; the recognized directive still passes through the policy gateway.
  startVoiceCapture('wake');
}

function enableWakeDetection() {
  if (handsFreeEnabled) { disableWakeDetection(); return; }
  if (isMicMuted) {
    setAssistantState('PRIVACY MODE — MIC MUTED', 'Unmute the microphone before enabling local wake detection.');
    return;
  }
  handsFreeEnabled = true;
  isHandsFreeEnabled = true;
  handsFreeStandby = false;
  updateHandsFreeButtons();
  setAssistantState('LOADING LOCAL WAKE ENGINE', 'Loading the on-device wake-word model. No audio is sent during wake detection.');
  startLocalWakeEngine().catch((error) => {
    handsFreeEnabled = false;
    isHandsFreeEnabled = false;
    handsFreeStandby = false;
    stopHandsFreeStandby();
    updateHandsFreeButtons();
    setAssistantState('LOCAL WAKE WORD UNAVAILABLE', error instanceof Error ? error.message : 'Local wake-word runtime/model is unavailable. Run scripts/setup-local-wake-word.ps1 and retry.');
  });
}

function disableWakeDetection() {
  handsFreeEnabled = false;
  isHandsFreeEnabled = false;
  handsFreeStandby = false;
  wakeCaptureAwaitingReview = false;
  stopHandsFreeStandby();
  if (isListening) cancelVoiceCapture();
  updateHandsFreeButtons();
  setAssistantState('HANDS-FREE DISABLED', 'Local wake detection and microphone capture are stopped. Push-to-talk remains available.');
}

function scheduleBrowserWakeRetry() {
  if (document.visibilityState === 'hidden' || !handsFreeEnabled || !handsFreeStandby || isMicMuted) return;
  if (handsFreeRestartTimer) clearTimeout(handsFreeRestartTimer);
  if (browserWakeRetryCount >= MAX_BROWSER_WAKE_RETRIES) {
    handsFreeRestartTimer = null;
    setAssistantState('WAKE LISTENING PAUSED', 'Browser wake recognition repeatedly ended without a usable transcript. Listening is paused to avoid a microphone retry loop. Resume listening or use push-to-talk/text input.');
    handsFreeStandby = false;
    updateHandsFreeButtons();
    return;
  }
  const delay = Math.min(8000, 700 * (2 ** browserWakeRetryCount));
  browserWakeRetryCount += 1;
  handsFreeRestartTimer = setTimeout(() => {
    handsFreeRestartTimer = null;
    if (document.visibilityState !== 'hidden' && handsFreeEnabled && handsFreeStandby && !isMicMuted && !handsFreeRecognizer) {
      startHandsFreeStandby();
    }
  }, delay);
}

function startHandsFreeStandby() {
  // The browser-based fallback must follow the same foreground-only rule as
  // the local wake engine. Do not open a recognition session from a delayed
  // callback while the HUD is hidden.
  if (!handsFreeEnabled || !speechRecognitionConstructor || isMicMuted || document.visibilityState === 'hidden') return;
  // stopHandsFreeStandby() resets the shared standby flag while releasing any
  // prior engine/recognizer. Restore it before wiring callbacks, all of which
  // require an active standby lifecycle.
  stopHandsFreeStandby();
  handsFreeStandby = true;
  updateHandsFreeButtons();
  let recognizer;
  try {
    recognizer = new speechRecognitionConstructor();
  } catch (error) {
    scheduleBrowserWakeRetry();
    return;
  }
  recognizer.continuous = true;
  recognizer.interimResults = false;
  recognizer.lang = 'en-US';

  recognizer.onstart = () => {
    if (handsFreeRecognizer !== recognizer || !handsFreeEnabled || !handsFreeStandby) return;
    setAssistantState('STANDBY', 'Listening for wake phrase…');
  };

  recognizer.onresult = (event) => {
    if (handsFreeRecognizer !== recognizer || !handsFreeEnabled || !handsFreeStandby || isSubmitting) return;
    let transcript = '';
    for (let index = 0; index < event.results.length; index++) {
      transcript += event.results[index][0].transcript;
    }
    const normalized = normalizeSpeechText(transcript);
    if (!normalized) return;
    browserWakeRetryCount = 0;

    if (isStopPhrase(normalized)) {
      handleHandsFreeStop();
      return;
    }

    if (isWakePhrase(normalized)) {
      browserWakeRetryCount = 0;
      const wakePatterns = [/\bhey jarvis\b/, /\bhello jarvis\b/, /\bhi jarvis\b/, /\bi am here\b/, /\bim here\b/];
      let command = normalized;
      for (const pattern of wakePatterns) {
        if (pattern.test(command)) { command = command.replace(pattern, ' ').trim(); break; }
      }
      if (command) {
        handsFreeStandby = false;
        stopHandsFreeStandby();
        updateHandsFreeButtons();
        setAssistantState('COMMAND RECEIVED', command);
        void submitDirective(command);
      } else {
        handleHandsFreeWake();
      }
    }
  };

  recognizer.onerror = (event) => {
    if (handsFreeRecognizer !== recognizer || !handsFreeEnabled) return;
    if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
      setAssistantState('MICROPHONE DENIED', 'Allow microphone access for this site in browser settings, then enable listening again.');
      disableWakeDetection();
      return;
    }
    if (event.error === 'audio-capture') {
      setAssistantState('MICROPHONE UNAVAILABLE', 'Another app may be using the microphone, or no input device is available.');
    } else if (event.error === 'network') {
      // Browser speech recognition commonly depends on a remote service. Do not
      // restart it in a tight loop when that service is unreachable.
      disableWakeDetection();
      setAssistantState('SPEECH SERVICE UNAVAILABLE', 'The browser recognition service is unreachable. Hands-free has been paused to prevent repeated failures. Use text input, or retry voice after the connection is restored.');
      return;
    } else if (event.error === 'aborted') {
      // A deliberate stop/restart can emit "aborted"; it is not a user-facing fault.
      return;
    } else if (event.error === 'no-speech') {
      setAssistantState('NO SPEECH DETECTED', 'I did not hear speech. Check the selected microphone and try again.');
    } else {
      setAssistantState('VOICE RECOGNITION ERROR', `Recognition failed: ${event.error}. You can retry or use text input.`);
    }
    if (handsFreeStandby && handsFreeEnabled) scheduleBrowserWakeRetry();
  };

  recognizer.onend = () => {
    // A stopped/replaced recognizer can emit onend asynchronously. Only the
    // current recognizer may schedule its successor, preventing overlapping
    // browser microphone sessions during wake/capture transitions.
    if (handsFreeRecognizer !== recognizer) return;
    handsFreeRecognizer = null;
    if (!handsFreeEnabled || !handsFreeStandby || handsFreeRestartTimer) return;
    scheduleBrowserWakeRetry();
  };

  handsFreeRecognizer = recognizer;
  try {
    recognizer.start();
  } catch (error) {
    if (handsFreeRecognizer === recognizer) handsFreeRecognizer = null;
    // Synchronous start failures must share the same bounded retry budget as
    // asynchronous onerror/onend failures; otherwise a rejected start() can
    // reopen the microphone forever on a fixed 800 ms loop.
    if (handsFreeEnabled && handsFreeStandby) scheduleBrowserWakeRetry();
  }
}

function handleHandsFreeWake() {
  if (isSubmitting || isListening) return;
  handsFreeStandby = false;
  stopHandsFreeStandby();
  setAssistantState('LISTENING...', 'Wake phrase detected. Speak your command.');
  updateHandsFreeButtons();
  setTimeout(() => {
    if (handsFreeEnabled && !isListening) startVoiceCapture();
  }, 120);
}

function handleHandsFreeStop() {
  if (isSubmitting) {
    setAssistantState('ACTION IN PROGRESS', 'Current directive is still executing; stop phrase only ends standby listening.');
    return;
  }
  handsFreeStandby = true;
  stopHandsFreeStandby();
  if (isListening) cancelVoiceCapture();
  setAssistantState('STOPPED', 'Hands-free listening stopped; standby is ready for a new wake phrase.');
  updateHandsFreeButtons();
  // Resume the on-device wake engine, not the legacy browser SpeechRecognition
  // standby path. Wake-word monitoring must remain local and foreground-only.
  if (handsFreeEnabled && !isMicMuted) scheduleHandsFreeRestart();
}

function initSpeechRecognition() {
  if (!window.isSecureContext) {
    speechRecognitionConstructor = null;
    speechUnavailableReason = 'Voice input needs HTTPS or a trusted localhost origin. Text input remains available.';
    return;
  }
  speechRecognitionConstructor = window.SpeechRecognition || window.webkitSpeechRecognition || null;
  if (!speechRecognitionConstructor) {
    speechUnavailableReason = 'This browser does not support speech recognition. Text input remains available.';
    console.warn('SpeechRecognition API not available in browser. Push-to-talk will use text input fallback.');
  }
}

function createSpeechRecognizer(captureGeneration, mode = 'push-to-talk') {
  const recognizer = new speechRecognitionConstructor();
  let finalTranscript = '';
  let captureFinished = false;
  recognizer.continuous = false;
  recognizer.interimResults = true;
  recognizer.lang = 'en-US';

  recognizer.onstart = () => {
    if (captureGeneration !== voiceCaptureGeneration || !isListening) return;
    setAssistantState('LISTENING...', 'Capturing voice command...');
    document.getElementById('reactor-container').classList.add('listening');
    document.getElementById('btn-ptt').classList.add('active');
  };

  recognizer.onresult = (event) => {
    if (captureGeneration !== voiceCaptureGeneration || discardVoiceResult) return;
    if (!hasSpeechConsent(mode)) {
      revokeSpeechConsent(mode);
      return;
    }
    if (isMicMuted || isSpeaking) return;
    // Push-to-talk remains review-first; consented post-wake capture can dispatch
    // through the policy gateway. Keep finalized segments separate from interim
    // hypotheses to avoid duplicated words.
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      if (result.isFinal) finalTranscript += result[0].transcript + ' ';
    }
    const interimTranscript = Array.from(event.results)
      .filter((result) => !result.isFinal)
      .map((result) => result[0].transcript)
      .join(' ');
    const transcript = `${finalTranscript} ${interimTranscript}`.trim();
    if (!transcript) return;
    document.getElementById('transcript-input').value = transcript;
    document.getElementById('transcript-box').classList.remove('hidden');
  };

  recognizer.onerror = (event) => {
    if (captureGeneration !== voiceCaptureGeneration) return;
    if (event.error === 'aborted') {
      // Expected when capture is cancelled or a recognizer is replaced.
      return;
    }
    if (event.error === 'network') {
      isListening = false;
      if (voiceTimeoutId) { clearTimeout(voiceTimeoutId); voiceTimeoutId = null; }
      document.getElementById('reactor-container').classList.remove('listening');
      document.getElementById('btn-ptt').classList.remove('active');
      if (isHandsFreeEnabled) disableHandsFree();
      else cancelVoiceCapture();
      setAssistantState('SPEECH SERVICE UNAVAILABLE', 'The browser speech-recognition service could not be reached. Your microphone may still be working. Use the text box, or retry voice when the browser service is available.');
      return;
    }
    console.warn('Speech recognition error:', event.error);
    if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
      cancelVoiceCapture();
      disableHandsFree();
      setAssistantState('MICROPHONE PERMISSION REQUIRED', 'Allow microphone access for this site in browser settings, then retry voice input.');
      return;
    }
    if (mode === 'wake') {
      // Any non-network, non-permission wake-capture error makes the transcript
      // uncertain. Invalidate callbacks and discard it rather than allowing
      // onend to auto-submit a partial command.
      const shouldRecover = handsFreeEnabled && !isMicMuted;
      cancelVoiceCapture();
      const failure = describeSpeechRecognitionError(event.error);
      setAssistantState('VOICE CAPTURE INTERRUPTED — COMMAND NOT SENT', `${failure.detail} No command was sent; the partial transcript was discarded.`);
      if (shouldRecover) scheduleHandsFreeRestart();
      return;
    }
    if (isHandsFreeEnabled && !isMicMuted) {
      isListening = false;
      if (voiceTimeoutId) { clearTimeout(voiceTimeoutId); voiceTimeoutId = null; }
      document.getElementById('reactor-container').classList.remove('listening');
      document.getElementById('btn-ptt').classList.remove('active');
      setAssistantState('VOICE RECOVERING', `Speech recognition interrupted (${event.error}). Retrying wake detection.`);
      scheduleHandsFreeRestart();
      return;
    }
    cancelVoiceCapture();
    const failure = describeSpeechRecognitionError(event.error);
    setAssistantState(failure.title, failure.detail);
  };

  recognizer.onend = () => {
    // Some browser implementations can emit overlapping terminal events. Process
    // a capture's final transcript at most once so a wake command is never double-submitted.
    if (captureGeneration !== voiceCaptureGeneration || captureFinished) return;
    captureFinished = true;
    if (!hasSpeechConsent(mode)) {
      revokeSpeechConsent(mode);
      return;
    }
    activeVoiceCaptureMode = null;
    isListening = false;
    document.getElementById('btn-ptt').setAttribute('aria-pressed', 'false');
    if (voiceTimeoutId) {
      clearTimeout(voiceTimeoutId);
      voiceTimeoutId = null;
    }
    document.getElementById('reactor-container').classList.remove('listening');
    document.getElementById('btn-ptt').classList.remove('active');
    stopAudioMeter();
    if (discardVoiceResult) {
      document.getElementById('transcript-input').value = '';
      document.getElementById('transcript-box').classList.add('hidden');
      discardVoiceResult = false;
    } else if (!isMicMuted && finalTranscript.trim() && mode === 'wake') {
      // Local wake detection plus the separate session consent authorizes
      // capturing this spoken directive. Dispatch it to the existing policy
      // gateway automatically; the gateway can still deny or require approval.
      const recognizedCommand = finalTranscript.trim().replace(/\s+/g, ' ')
        .replace(/^(?:hey|hello|hi)\s+jarvis\b[,.!?;: -]*/i, '').trim();
      wakeCaptureAwaitingReview = false;
      document.getElementById('transcript-input').value = '';
      document.getElementById('transcript-box').classList.add('hidden');
      void completeWakeCapture(recognizedCommand);
    } else if (!isMicMuted && finalTranscript.trim()) {
      // Push-to-talk remains review-first; only post-wake commands are sent
      // directly to the policy gateway after explicit session consent.
      const recognizedCommand = finalTranscript.trim().replace(/\s+/g, ' ');
      document.getElementById('transcript-input').value = recognizedCommand;
      document.getElementById('transcript-box').classList.remove('hidden');
      setAssistantState('VOICE TRANSCRIPT READY', 'Review or edit the recognized command, then select EXECUTE DIRECTIVE. Nothing has been sent yet.');
    } else if (wakeCaptureAwaitingReview && handsFreeEnabled && !isMicMuted) {
      wakeCaptureAwaitingReview = false;
      void completeWakeCapture('');
    }
  };

  return recognizer;
}


/**
 * Completes a post-wake capture. If the recognizer starts too late to hear
 * the command spoken immediately after the wake phrase, give the owner one
 * explicit second-command window after the acknowledgement. This remains
 * consent-gated and still submits only through the signed policy-gateway path.
 */
async function completeWakeCapture(command) {
  await speakResponse('Hi sir, I am ready to work.');
  const speechDeadline = Date.now() + 8000;
  while (isSpeaking && Date.now() < speechDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  if (command) {
    if (!hasSpeechConsent('wake')) {
      wakeCommandRetryCount = 0;
      setAssistantState('VOICE CONSENT REVOKED — COMMAND NOT SENT', 'Post-wake browser speech consent was withdrawn before dispatch. No command was sent.');
      scheduleHandsFreeRestart();
      return;
    }
    wakeCommandRetryCount = 0;
    setAssistantState('COMMAND RECEIVED', command);
    await submitDirective(command);
    return;
  }

  if (handsFreeEnabled && !isMicMuted && hasSpeechConsent('wake') && wakeCommandRetryCount < MAX_WAKE_COMMAND_RETRIES) {
    wakeCommandRetryCount += 1;
    setAssistantState('READY FOR COMMAND', 'I heard the wake phrase. Please say your command now.');
    startVoiceCapture('wake');
    return;
  }

  wakeCommandRetryCount = 0;
  setAssistantState('NO COMMAND RECOGNIZED', 'No command was captured. Wake detection is restarting; try again or use text input.');
  scheduleHandsFreeRestart();
}

/**
 * Explain browser speech-recognition failures in actionable terms.
 * Adapted from the legacy JARVIS_ABHI voice-input pattern: distinguish
 * silence, missing devices, and service/network failures instead of
 * reporting every failure as a generic engine error.
 */
function describeSpeechRecognitionError(error) {
  const messages = {
    'no-speech': {
      title: 'NO SPEECH DETECTED',
      detail: 'No speech was detected. Check your microphone input level, then press the voice button and try again.'
    },
    'audio-capture': {
      title: 'MICROPHONE UNAVAILABLE',
      detail: 'No usable microphone was found. Check Windows microphone settings, the selected input device, and whether another app is using it.'
    },
    'network': {
      title: 'SPEECH SERVICE UNAVAILABLE',
      detail: 'The browser speech service could not be reached. Check internet access or use the text input; this does not indicate that the local JARVIS core is offline.'
    },
    'aborted': {
      title: 'VOICE CAPTURE STOPPED',
      detail: 'The browser stopped voice capture before a transcript was ready. Press the voice button to try again.'
    },
    'language-not-supported': {
      title: 'SPEECH LANGUAGE UNAVAILABLE',
      detail: 'The browser does not support the configured English recognition language. Try a supported browser or use text input.'
    }
  };
  return messages[error] || {
    title: 'SPEECH RECOGNITION ERROR',
    detail: `Browser recognition failed (${String(error || 'unknown error')}). Check microphone permissions and retry, or use text input.`
  };
}

function normalizeVoiceText(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9' ]/g, ' ').replace(/\s+/g, ' ').trim();
}

function handleHandsFreeTranscript(rawTranscript) {
  const normalized = normalizeVoiceText(rawTranscript);
  const wakePatterns = [/\bhey jarvis\b/, /\bhello jarvis\b/, /\bhi jarvis\b/, /\bi am here\b/, /\bi'm here\b/];
  const stopPatterns = [/\bstop jarvis\b/, /\bjarvis stop\b/, /\bjarvis you may leave(?: now)?\b/, /\byou may leave jarvis\b/, /\bgoodbye jarvis\b/, /\bgo to sleep jarvis\b/];
  if (stopPatterns.some((pattern) => pattern.test(normalized))) {
    isWaitingForWakeCommand = false;
    setAssistantState('STANDBY — WAKE PHRASE READY', 'Hands-free standby is active. Say “Hey JARVIS” for a command, or disable hands-free to release the microphone.');
    void speakResponse('Standing by. Say Hey JARVIS when you need me.');
    return;
  }
  let command = normalized;
  let foundWake = false;
  for (const pattern of wakePatterns) {
    if (pattern.test(command)) { foundWake = true; command = command.replace(pattern, ' ').trim(); break; }
  }
  if (foundWake) {
    isWaitingForWakeCommand = true;
    if (command) {
      isWaitingForWakeCommand = false;
      setAssistantState('COMMAND RECEIVED', command);
      void submitDirective(command);
    } else {
      setAssistantState('JARVIS IS LISTENING', 'Wake phrase detected. Say your command now.');
      void speakResponse('Hi sir, I am ready to work.');
    }
    return;
  }
  if (isWaitingForWakeCommand) {
    isWaitingForWakeCommand = false;
    setAssistantState('COMMAND RECEIVED', rawTranscript);
    void submitDirective(rawTranscript);
  }
}

function scheduleHandsFreeRestart() {
  // Do not queue microphone work while the HUD is backgrounded. Capture
  // cancellation can itself request recovery, so gate both scheduling and
  // timer execution on visibility; the visibilitychange handler retries when
  // the user returns to the HUD.
  if (document.visibilityState === 'hidden') {
    if (handsFreeRestartTimer) clearTimeout(handsFreeRestartTimer);
    handsFreeRestartTimer = null;
    return;
  }
  if (handsFreeRestartTimer) clearTimeout(handsFreeRestartTimer);
  handsFreeRestartTimer = setTimeout(() => {
    handsFreeRestartTimer = null;
    if (document.visibilityState === 'hidden' || !handsFreeEnabled || isMicMuted || isSpeaking || isListening || isSubmitting || wakeCaptureAwaitingReview) return;
    startLocalWakeEngine().catch((error) => {
      setAssistantState('LOCAL WAKE WORD UNAVAILABLE', error instanceof Error ? error.message : 'Could not restart local wake detection.');
      disableWakeDetection();
    });
  }, 700);
}

function enableHandsFree() {
  if (!handsFreeEnabled) enableWakeDetection();
  else disableHandsFree();
}

function disableHandsFree() {
  handsFreeEnabled = false;
  isHandsFreeEnabled = false;
  handsFreeStandby = false;
  isWaitingForWakeCommand = false;
  wakeCaptureAwaitingReview = false;
  stopHandsFreeStandby();
  const button = document.getElementById('btn-hands-free');
  if (button) { button.textContent = 'HANDS-FREE CAPTURE: OFF'; button.setAttribute('aria-pressed', 'false'); }
  cancelVoiceCapture();
  cancelSpeechOutput();
  updateHandsFreeButtons();
  setAssistantState(isMicMuted ? 'PRIVACY MODE — MIC MUTED' : 'HANDS-FREE DISABLED', 'Local wake detection and microphone capture are stopped.');
}

function hasSpeechConsent(mode) {
  const consentId = mode === 'wake' ? 'allow-wake-browser-speech' : 'allow-browser-speech';
  return document.getElementById(consentId)?.checked === true;
}

function revokeSpeechConsent(mode) {
  if (activeVoiceCaptureMode !== mode) return;
  cancelVoiceCapture();
  setAssistantState('VOICE CONSENT REVOKED — CAPTURE STOPPED', mode === 'wake'
    ? 'Post-wake browser speech consent was withdrawn. Capture was cancelled and its transcript discarded; local wake detection may remain enabled.'
    : 'Push-to-talk browser speech consent was withdrawn. Capture was cancelled and its transcript discarded.');
}

function startVoiceCapture(mode = 'push-to-talk') {
  if (isMicMuted) {
    setAssistantState('PRIVACY MODE — MIC MUTED', 'Unmute the microphone before starting voice capture.');
    return;
  }
  if (isListening) return;
  if (!hasSpeechConsent(mode)) {
    setAssistantState('VOICE CONSENT REQUIRED', mode === 'wake'
      ? 'Local wake detection succeeded, but post-wake browser speech consent is not enabled. Use push-to-talk or text input.'
      : 'Browser speech recognition may send captured audio to a vendor service. Check the one-session consent box before using push-to-talk, or use text input.');
    return;
  }
  if (localWakeEngine) stopHandsFreeStandby();
  wakeCaptureAwaitingReview = mode === 'wake';
  if (!speechRecognitionConstructor) {
    setAssistantState(window.isSecureContext ? 'SPEECH API UNAVAILABLE' : 'SECURE CONTEXT REQUIRED',
      speechUnavailableReason || 'Use the text input field; no audio capture was started.');
    if (mode === 'wake') {
      wakeCaptureAwaitingReview = false;
      scheduleHandsFreeRestart();
    }
    return;
  }

  discardVoiceResult = false;
  document.getElementById('transcript-input').value = '';
  document.getElementById('transcript-box').classList.add('hidden');
  isListening = true;
  activeVoiceCaptureMode = mode;
  document.getElementById('btn-ptt').setAttribute('aria-pressed', 'true');
  const captureGeneration = ++voiceCaptureGeneration;
  try {
    speechRecognizer = createSpeechRecognizer(captureGeneration, mode);
    speechRecognizer.start();
    // SpeechRecognition owns the microphone stream. Opening a second
    // getUserMedia stream for the decorative level meter can trigger a second
    // permission prompt or contend with the recognizer on Windows browsers.
    // Keep the waveform in its honest “capturing / no level data” state.
    voiceTimeoutId = setTimeout(() => {
      if (!isListening || captureGeneration !== voiceCaptureGeneration) return;
      if (mode === 'wake') {
        // A timed-out hands-free utterance may be incomplete. Abort it rather
        // than letting recognizer.onend dispatch a partial command automatically.
        cancelVoiceCapture();
        setAssistantState('VOICE TIME LIMIT — COMMAND NOT SENT', 'The post-wake capture reached 15 seconds. No command was sent; wake detection will recover for another attempt.');
        return;
      }
      stopVoiceCapture(isHandsFreeEnabled ? 'HANDS-FREE STANDBY' : 'VOICE TIME LIMIT', isHandsFreeEnabled ? 'Refreshing the browser recognition session.' : 'The 15-second capture limit was reached. Review the transcript before sending.');
    }, 15000);
  } catch (e) {
    isListening = false;
    activeVoiceCaptureMode = null;
    document.getElementById('btn-ptt').setAttribute('aria-pressed', 'false');
    document.getElementById('reactor-container').classList.remove('listening');
    document.getElementById('btn-ptt').classList.remove('active');
    voiceCaptureGeneration++;
    if (voiceTimeoutId) clearTimeout(voiceTimeoutId);
    voiceTimeoutId = null;
    speechRecognizer = null;
    stopAudioMeter();
    if (mode === 'wake') {
      wakeCaptureAwaitingReview = false;
      setAssistantState('VOICE START FAILED', 'The browser could not start post-wake speech recognition. No command was sent; local wake detection will retry. You can also use text input.');
      scheduleHandsFreeRestart();
    } else {
      setAssistantState('VOICE START FAILED', 'The browser could not start speech recognition. Use text input instead.');
    }
  }
}

function stopVoiceCapture(label = 'CONFIRM DIRECTIVE', detail = 'Verify or edit the transcript before dispatch.') {
  if (!isListening) return;
  isListening = false;
  document.getElementById('btn-ptt').setAttribute('aria-pressed', 'false');
  document.getElementById('reactor-container').classList.remove('listening');
  document.getElementById('btn-ptt').classList.remove('active');
  if (voiceTimeoutId) {
    clearTimeout(voiceTimeoutId);
    voiceTimeoutId = null;
  }
  if (speechRecognizer) {
    try {
      speechRecognizer.stop();
      stopAudioMeter();
    } catch (e) {
      setAssistantState('VOICE STOP UNCERTAIN', 'Check microphone indicator and use Cancel if capture continues.');
    }
  }
  setAssistantState(label, detail);
}

function cancelVoiceCapture() {
  isListening = false;
  activeVoiceCaptureMode = null;
  document.getElementById('btn-ptt').setAttribute('aria-pressed', 'false');
  discardVoiceResult = true;
  voiceCaptureGeneration++;
  if (voiceTimeoutId) {
    clearTimeout(voiceTimeoutId);
    voiceTimeoutId = null;
  }
  const recognizerToAbort = speechRecognizer;
  speechRecognizer = null;
  stopAudioMeter();
  if (recognizerToAbort) {
    try {
      recognizerToAbort.abort();
    } catch (e) {
      // The capture generation is invalidated even if the browser cannot abort.
    }
  }
  document.getElementById('reactor-container').classList.remove('listening');
  document.getElementById('btn-ptt').classList.remove('active');
  document.getElementById('transcript-input').value = '';
  document.getElementById('transcript-box').classList.add('hidden');
  const shouldResumeWake = handsFreeEnabled && wakeCaptureAwaitingReview;
  wakeCaptureAwaitingReview = false;
  setAssistantState('IDLE — READY', 'Ready for directive.');
  if (shouldResumeWake) scheduleHandsFreeRestart();
}

function handleTextSubmit() {
  const input = document.getElementById('hud-text-input');
  const val = input.value.trim();
  if (!val) return;
  void submitDirective(val);
}

async function submitDirective(text) {
  if (!currentSession) {
    const message = 'Secure device enrollment is required before I can submit or execute directives. No action was sent.';
    setAssistantState('SESSION UNAVAILABLE — DIRECTIVE NOT SENT', message);
    addFeedItem('failed', message);
    setPipeline({ sent: 'bad' }, 'No authenticated device session; the request never reached the policy gateway.');
    speakResponse(message);
    return;
  }
  if (isSubmitting) return;
  isSubmitting = true;
  if (wakeCaptureAwaitingReview) wakeCaptureAwaitingReview = false;
  const sendButton = document.getElementById('btn-hud-send');
  const transcriptSubmit = document.getElementById('btn-transcript-submit');
  const textInput = document.getElementById('hud-text-input');
  const transcriptInput = document.getElementById('transcript-input');
  const sourceWasTranscript = !document.getElementById('transcript-box').classList.contains('hidden') &&
    transcriptInput.value.trim() === text;
  const originalButtonText = sendButton.textContent;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000);
  sendButton.disabled = true;
  transcriptSubmit.disabled = true;
  sendButton.textContent = 'TRANSMITTING…';
  setAssistantState('PROCESSING DIRECTIVE...', 'Evaluating via Policy Gateway...');
  addFeedItem('directive', text);
  setPipeline({ sent: 'active' }, 'Directive sent; waiting for the policy gateway.');

  try {
    const res = await window.JarvisDeviceCrypto.signedFetch('/api/request', {
      method: 'POST',
      body: { text },
      signal: controller.signal,
    });
    const data = await readApiResponse(res);
    if (typeof data.message === 'string') data.message = normalizeUserFacingMessage(data.message);
    if (data.approvalId && data.state === 'AWAITING_APPROVAL') {
      setAssistantState('AWAITING CONSENT', data.message);
      speakResponse(data.message || 'I need your approval before performing that action.');
      renderApprovalCard(data.approvalId, data.taskId, text, data.message);
      addFeedItem('pending', `Approval Required: ${data.message}`);
      setPipeline({ sent: 'done', policy: 'done', approval: 'warn' }, 'Waiting for your explicit approval. It is single-use and bound to this exact action.');
    } else if (data.state === 'COMPLETED' &&
        data.outcome === 'VERIFIED_SUCCESS' && data.verified === true) {
      setAssistantState('DIRECTIVE EXECUTED', data.message);
      addFeedItem('success', `Verified Result: ${data.message}`, data.data);
      setPipeline({ sent: 'done', policy: 'done', approval: 'skip', verify: 'done' }, 'Policy allowed it without approval and the host outcome was verified.');
      speakResponse(data.message || 'The action completed successfully.');
    } else if (data.state === 'PARTIAL' || data.state === 'AWAITING_RECOVERY' ||
        data.outcome === 'UNCERTAIN' || data.verified === false) {
      setAssistantState('OUTCOME NOT VERIFIED', data.message);
      addFeedItem('pending', `Outcome not fully verified: ${data.message}`, data.data);
      setPipeline({ sent: 'done', policy: 'done', approval: 'skip', verify: 'warn' }, 'The outcome could not be confirmed. Check the host before retrying.');
      speakResponse(data.message || 'I could not fully verify the outcome.');
    } else {
      setAssistantState('EXECUTION DENIED / FAILED', data.message || data.error);
      addFeedItem('failed', `Denied: ${data.message || data.error}`);
      setPipeline({ sent: 'done', policy: 'bad' }, 'Denied or failed at the policy gateway. Nothing was executed.');
      speakResponse(data.message || data.error || 'The request was denied or failed.');
    }
    if (textInput.value.trim() === text) textInput.value = '';
    if (sourceWasTranscript) {
      transcriptInput.value = '';
      document.getElementById('transcript-box').classList.add('hidden');
    }
  } catch (err) {
    const message = controller.signal.aborted
      ? 'Request timed out; the server may have received it. Check the task feed before retrying.'
      : (err instanceof Error ? err.message : 'Request failed');
    setAssistantState('COMMUNICATION FAILURE', message);
    addFeedItem('failed', message);
    setPipeline({ sent: 'bad' }, 'The request did not complete. Its server-side state is unknown.');
    speakResponse(message);
    if (sourceWasTranscript && !textInput.value.trim()) textInput.value = text;
  } finally {
    clearTimeout(timeoutId);
    isSubmitting = false;
    sendButton.disabled = false;
    transcriptSubmit.disabled = false;
    sendButton.textContent = originalButtonText;
    if (isHandsFreeEnabled && !isSpeaking && !isListening && !isMicMuted) scheduleHandsFreeRestart();
  }
}


function cancelSpeechOutput() {
  // Invalidate any synthesis request that is still awaiting a network response.
  speechOutputGeneration += 1;
  if (handsFreeRestartTimer) {
    clearTimeout(handsFreeRestartTimer);
    handsFreeRestartTimer = null;
  }
  if (activeSpeechAudio) {
    try {
      activeSpeechAudio.pause();
      activeSpeechAudio.removeAttribute('src');
      activeSpeechAudio.load();
    } catch { /* Best-effort stop; cleanup below still releases the object URL. */ }
  }
  if (activeSpeechCleanup) activeSpeechCleanup();
  else {
    if (activeSpeechAudioUrl) URL.revokeObjectURL(activeSpeechAudioUrl);
    activeSpeechAudioUrl = null;
    activeSpeechAudio = null;
  }
  if (speechSynthesisAvailable) window.speechSynthesis.cancel();
  isSpeaking = false;
}

async function speakResponse(message) {
  const text = String(message || '').trim();
  if (!text || isMicMuted || !speechOutputEnabled) return;
  // A new response supersedes earlier speech and invalidates stale async TTS work.
  cancelSpeechOutput();
  const generation = speechOutputGeneration;
  const stillAllowed = () => generation === speechOutputGeneration && !isMicMuted && speechOutputEnabled;
  if (!localTtsUnavailable && currentSession && window.JarvisDeviceCrypto?.signedFetch) {
    try {
      const response = await window.JarvisDeviceCrypto.signedFetch('/api/voice/synthesize', {
        method: 'POST', body: { text: text.slice(0, 1200) },
      });
      if (!stillAllowed()) return;
      if (!response.ok) {
        // A failing local provider will not be retried for every response.
        // Browser speech synthesis is the graceful fallback for this session.
        if (response.status === 502 || response.status === 503) localTtsUnavailable = true;
        throw new Error(`Local TTS returned HTTP ${response.status}`);
      }
      const blob = await response.blob();
      if (!stillAllowed()) return;
      if (blob.type.includes('audio/wav') && blob.size > 44) {
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        let playbackFinished = false;
        const finishPlayback = () => {
          if (playbackFinished) return;
          playbackFinished = true;
          if (activeSpeechAudio === audio) {
            activeSpeechAudio = null;
            activeSpeechAudioUrl = null;
            activeSpeechCleanup = null;
          }
          URL.revokeObjectURL(url);
          isSpeaking = false;
          if (isHandsFreeEnabled && !isMicMuted && speechOutputEnabled) scheduleHandsFreeRestart();
        };
        activeSpeechAudio = audio;
        activeSpeechAudioUrl = url;
        activeSpeechCleanup = finishPlayback;
        // Attach terminal handlers before play(): short clips can finish quickly,
        // and media errors after play() resolves must still release speech state.
        audio.addEventListener('ended', finishPlayback, { once: true });
        audio.addEventListener('error', finishPlayback, { once: true });
        try {
          isSpeaking = true;
          await audio.play();
          return;
        } catch (playError) {
          finishPlayback();
          throw playError;
        }
      }
      localTtsUnavailable = true;
      throw new Error('Local TTS returned an invalid audio response');
    } catch (error) {
      if (!stillAllowed()) return;
      console.warn('Local neural TTS unavailable; using browser speech synthesis.', error);
    }
  }
  if (!stillAllowed()) return;
  if ('speechSynthesis' in window && 'SpeechSynthesisUtterance' in window) {
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    isSpeaking = true;
    utterance.lang = 'en-GB';
    utterance.rate = 0.92;
    utterance.pitch = 0.9;
    const finishSpeech = () => {
      if (generation !== speechOutputGeneration) return;
      isSpeaking = false;
      if (isHandsFreeEnabled && !isMicMuted && speechOutputEnabled) scheduleHandsFreeRestart();
    };
    utterance.onend = finishSpeech;
    utterance.onerror = finishSpeech;
    window.speechSynthesis.speak(utterance);
  }
}

function normalizeUserFacingMessage(value) {
  if (typeof value !== 'string') return '';
  let text = value.trim();
  if (!text) return '';
  // Only unwrap JSON-looking strings; normal prose remains untouched.
  if ((text.startsWith('{') && text.endsWith('}')) || (text.startsWith('[') && text.endsWith(']'))) {
    try {
      const parsed = JSON.parse(text);
      const extract = (candidate, depth = 0) => {
        if (depth > 4 || candidate == null) return '';
        if (typeof candidate === 'string') return normalizeUserFacingMessage(candidate);
        if (Array.isArray(candidate)) return candidate.map(item => extract(item, depth + 1)).filter(Boolean).join('\n');
        if (typeof candidate === 'object') {
          for (const key of ['answer', 'response', 'message', 'text', 'content', 'explanation']) {
            if (typeof candidate[key] === 'string' && candidate[key].trim()) return extract(candidate[key], depth + 1);
          }
        }
        return '';
      };
      const extracted = extract(parsed);
      if (extracted) return extracted;
    } catch { /* Leave malformed or non-response JSON readable as a safe string. */ }
  }
  return text;
}

async function readApiResponse(response) {
  const raw = await response.text();
  let payload;
  try { payload = raw ? JSON.parse(raw) : {}; } catch {
    payload = { error: raw.slice(0, 240) || 'The server returned a non-JSON response' };
  }
  if (!response.ok) {
    const explanation = typeof payload.error === 'string' ? payload.error :
      typeof payload.message === 'string' ? payload.message : 'Request failed';
    throw new Error(`HTTP ${response.status}: ${explanation}`);
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('The server returned an invalid response format');
  }
  return payload;
}

function updateMuteControl() {
  const button = document.getElementById('btn-toggle-mic-mute');
  if (!button) return;
  button.setAttribute('aria-pressed', String(isMicMuted));
  button.innerText = isMicMuted ? 'MIC: MUTED' : 'MIC: ARMED';
  button.classList.toggle('muted', isMicMuted);
}

function renderApprovalCard(approvalId, taskId, requestText, message) {
  const slot = document.getElementById('hud-approvals-slot');
  document.getElementById('hud-no-approvals-hint').classList.add('hidden');

  const card = document.createElement('div');
  card.className = 'hud-approval-card';
  card.id = 'hud-appr-' + approvalId;

  const directive = document.createElement('div');
  directive.className = 'hud-approval-directive';
  directive.textContent = 'DIRECTIVE: ' + String(requestText);

  const description = document.createElement('div');
  description.className = 'hud-approval-description';
  description.textContent = String(message || '');

  const actions = document.createElement('div');
  actions.className = 'hud-approval-actions';

  const approve = document.createElement('button');
  approve.className = 'hud-btn hud-btn-cyan';
  approve.textContent = 'CONFIRM & EXECUTE';
  approve.addEventListener('click', () => resolveHudApproval(approvalId, true));

  const reject = document.createElement('button');
  reject.className = 'hud-btn hud-btn-danger';
  reject.textContent = 'DENY';
  reject.addEventListener('click', () => resolveHudApproval(approvalId, false));

  actions.append(approve, reject);
  card.append(directive, description, actions);
  slot.appendChild(card);
  updateApprovalCountBadge();
}

async function resolveHudApproval(approvalId, approved) {
  // Approval records are single-use. Ignore rapid duplicate clicks while the
  // signed request is in flight, rather than sending competing resolutions.
  if (approvalResolutionsInFlight.has(approvalId)) return;
  const card = document.getElementById('hud-appr-' + approvalId);
  if (!card) return;
  if (!currentSession) {
    setAssistantState('SESSION UNAVAILABLE', 'Secure device enrollment is required before approvals can be submitted.');
    return;
  }

  approvalResolutionsInFlight.add(approvalId);
  const controls = Array.from(card.querySelectorAll('button'));
  controls.forEach((button) => {
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
  });
  const endpoint = approved ? '/api/approval/approve' : '/api/approval/reject';
  setAssistantState('RESOLVING APPROVAL...', 'Checking server authorization and task state...');

  try {
    const res = await window.JarvisDeviceCrypto.signedFetch(endpoint, {
      method: 'POST',
      body: { approvalId },
    });
    const result = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(result.error || 'Approval request failed with HTTP ' + res.status);

    if (!approved) {
      if (result.success !== true) throw new Error(result.message || result.error || 'Server did not confirm the rejection');
      card.remove();
      updateApprovalCountBadge();
      setAssistantState('DIRECTIVE REJECTED', result.message || 'The server confirmed that the action was rejected.');
      addFeedItem('failed', 'Directive rejected by operator.');
      setPipeline({ sent: 'done', policy: 'done', approval: 'bad' }, 'You rejected the action. Nothing was executed.');
      speakResponse('The directive was rejected.');
      return;
    }

    if (result.state === 'COMPLETED' && result.success === true &&
        result.outcome === 'VERIFIED_SUCCESS' && result.verified === true) {
      card.remove();
      updateApprovalCountBadge();
      setAssistantState('TASK COMPLETED', result.message || 'The server reports the task completed; review evidence before relying on the result.');
      addFeedItem('success', 'Task state: COMPLETED — ' + (result.message || 'No result details supplied'), result.data);
      setPipeline({ sent: 'done', policy: 'done', approval: 'done', verify: 'done' }, 'Approved, executed, and verified by the host.');
      speakResponse(result.message || 'The approved task completed and was verified.');
    } else if (['FAILED', 'REJECTED', 'EXPIRED', 'CANCELLED', 'PARTIAL', 'AWAITING_RECOVERY'].includes(result.state)) {
      card.remove();
      updateApprovalCountBadge();
      setAssistantState('TASK DID NOT COMPLETE', result.message || String(result.state));
      addFeedItem('failed', 'Approval was processed but the task did not complete: ' + String(result.state), result.data);
      setPipeline({ sent: 'done', policy: 'done', approval: 'done', verify: 'bad' }, 'Approved, but the task did not complete: ' + String(result.state));
      speakResponse(result.message || 'The approved task did not complete.');
    } else {
      // An accepted approval is not proof of execution. Keep the pending card
      // available while the task's terminal state remains unknown.
      setAssistantState('APPROVAL PROCESSED — NOT COMPLETE', result.message || 'Approval was processed but execution is not verified complete.');
      addFeedItem('pending', 'Approval processed; task state: ' + String(result.state || 'UNKNOWN'));
      setPipeline({ sent: 'done', policy: 'done', approval: 'done', verify: 'warn' }, 'Approval processed, but completion is not verified. Refresh task status before relying on it.');
    }
  } catch (err) {
    setAssistantState('APPROVAL STATUS UNKNOWN', err instanceof Error ? err.message : 'Approval request failed');
    addFeedItem('failed', 'Approval state could not be confirmed. Refresh task status before retrying.');
    setPipeline({ sent: 'done', policy: 'done', approval: 'warn' }, 'Approval state is unknown. Verify task status before retrying.');
    speakResponse(err instanceof Error ? err.message : 'Approval status could not be confirmed.');
  } finally {
    approvalResolutionsInFlight.delete(approvalId);
    if (card.isConnected) {
      controls.forEach((button) => {
        button.disabled = false;
        button.removeAttribute('aria-busy');
      });
    }
  }
}

function updateApprovalCountBadge() {
  const count = document.querySelectorAll('.hud-approval-card').length;
  const badge = document.getElementById('hud-pending-badge');
  badge.innerText = `${count} APPROVALS`;
  if (count === 0) {
    document.getElementById('hud-no-approvals-hint').classList.remove('hidden');
  }
}

function setAssistantState(mainLabel, subLabel) {
  document.getElementById('hud-state-label').innerText = mainLabel;
  if (subLabel) document.getElementById('hud-state-sub').innerText = subLabel;
  document.body.dataset.state = deriveVisualState(mainLabel);
}

// Maps the real status label to a visual state for the reactor core. The label
// is the source of truth; this only chooses colours and motion speed.
function deriveVisualState(label) {
  const text = String(label || '').toUpperCase();
  if (/MUTED|PRIVACY MODE/.test(text)) return 'muted';
  if (/PAUSED|DISABLED|STOPPED|REJECTED/.test(text)) return 'idle';
  if (/FAIL|DENIED|OFFLINE|UNREACHABLE|UNAVAILABLE|DEGRADED|REQUIRED|ERROR|UNKNOWN|NOT COMPLETE|NOT VERIFIED|DID NOT|UNCERTAIN|NO SPEECH/.test(text)) return 'error';
  if (/CONSENT|RECOVERING/.test(text)) return 'attention';
  if (/PROCESSING|RESOLVING|RECOGNIZED|COMMAND RECEIVED/.test(text)) return 'processing';
  if (/LISTENING/.test(text)) return 'listening';
  return 'idle';
}

function setNode(name, state, text) {
  const node = document.getElementById('node-' + name);
  if (!node) return;
  node.dataset.state = state;
  const value = document.getElementById('node-' + name + '-val');
  if (value) value.textContent = text;
}

const PIPELINE_STAGES = ['sent', 'policy', 'approval', 'verify'];

// Stage states: idle | active | done | warn | bad | skip. Only call this with
// states taken from an actual server response or a real request failure.
function setPipeline(states, note) {
  for (const stage of PIPELINE_STAGES) {
    const item = document.querySelector('#task-pipeline [data-stage="' + stage + '"]');
    if (item) item.dataset.state = states[stage] || 'idle';
  }
  const noteElement = document.getElementById('pipeline-note');
  if (noteElement && note) noteElement.textContent = note;
}

// Speaking state lives in script variables (browser TTS and local audio); mirror it
// to the document so the reactor can pulse. Cheap attribute compare, no rendering.
setInterval(() => {
  const speaking = String(isSpeaking);
  if (document.body.dataset.speaking !== speaking) document.body.dataset.speaking = speaking;
}, 250);

function addFeedItem(type, message, details) {
  const feed = document.getElementById('hud-tasks-feed');
  const item = document.createElement('div');
  item.className = 'task-entry ' + (type === 'success' ? 'success' : type === 'failed' ? 'failed' : type === 'pending' ? 'pending' : '');

  const time = document.createElement('span');
  time.className = 'task-time';
  time.textContent = '[' + new Date().toLocaleTimeString() + ']';

  const description = document.createElement('strong');
  description.textContent = String(message ?? '');
  item.append(time, document.createTextNode(' '), description);

  if (details !== undefined && details !== null) {
    const pre = document.createElement('pre');
    pre.className = 'hud-task-details';
    pre.textContent = typeof details === 'string' ? details : JSON.stringify(details, null, 2);
    item.appendChild(pre);
  }
  feed.insertBefore(item, feed.firstChild);
}

async function ensureEnrolledDevice() {
  try {
    const session = await window.JarvisDeviceCrypto.restoreSession();
    currentSession = session.sessionId;
    currentDevice = { id: session.deviceId, name: session.deviceName, permissions: session.permissions };
    document.getElementById('hud-device-name').textContent = currentDevice.name;
    document.getElementById('hud-device-id').textContent = currentDevice.id;
    document.getElementById('enclave-tag').textContent = 'ENROLLED & AUTHENTICATED';
    setNode('session', 'ok', 'SESSION OK');
    if (speechUnavailableReason) {
      setAssistantState(window.isSecureContext ? 'SPEECH API UNAVAILABLE' : 'SECURE CONTEXT REQUIRED', speechUnavailableReason);
    } else {
      setAssistantState('STANDBY', 'Device-bound session established. Confirm all transcribed directives before execution.');
    }
  } catch (err) {
    currentSession = null;
    currentDevice = null;
    document.getElementById('hud-device-name').textContent = 'Enrollment required';
    document.getElementById('hud-device-id').textContent = '--';
    document.getElementById('enclave-tag').textContent = 'SECURE ENROLLMENT REQUIRED';
    setNode('session', 'bad', 'NO SESSION');
    setAssistantState('SESSION UNAVAILABLE', err instanceof Error ? err.message : 'Enroll this browser through the companion UI first.');
  }
}

let hostWasUnreachable = false;

function describePlatform(platform) {
  const names = { win32: 'WINDOWS', darwin: 'MACOS', linux: 'LINUX' };
  return names[platform] || (typeof platform === 'string' && platform ? platform.toUpperCase().slice(0, 16) : 'UNKNOWN');
}

async function pollStatus() {
  // Skip polling while the tab is hidden; the next visible tick refreshes state.
  if (document.hidden) return;
  try {
    const res = await fetch('/api/status');
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error('Status request failed');
    if (data.status !== 'ONLINE' && data.status !== 'DEGRADED') throw new Error('Unknown server status response');
    // Telemetry shown here comes from the server response, not from constants.
    document.getElementById('tel-system').innerText = describePlatform(data.platform);
    document.getElementById('tel-host').innerText = window.location.host || 'LOCAL';
    if (hostWasUnreachable) {
      hostWasUnreachable = false;
      setAssistantState('HOST RECONNECTED', 'The local JARVIS core is reachable again.');
    }
    if (data.status === 'ONLINE') {
      document.getElementById('core-status-dot').classList.remove('degraded');
      document.getElementById('tel-audit').innerText = 'CORE HEALTHY';
      setNode('core', 'ok', 'HEALTHY');
      setNode('host', 'ok', 'LINKED');
    } else {
      document.getElementById('core-status-dot').classList.add('degraded');
      const failed = data.checks && typeof data.checks === 'object'
        ? Object.entries(data.checks).filter(([, ok]) => ok === false).map(([name]) => name)
        : [];
      document.getElementById('tel-audit').innerText = 'DEGRADED';
      setNode('core', 'bad', 'DEGRADED');
      setNode('host', 'ok', 'LINKED');
      setAssistantState('CORE DEGRADED', failed.length
        ? `Failed health checks: ${failed.join(', ')}. State-changing tasks must remain blocked.`
        : 'Security state needs attention. State-changing tasks must remain blocked.');
    }
  } catch {
    hostWasUnreachable = true;
    document.getElementById('core-status-dot').classList.add('degraded');
    document.getElementById('tel-host').innerText = 'OFFLINE';
    document.getElementById('tel-system').innerText = 'UNKNOWN';
    document.getElementById('tel-audit').innerText = 'UNREACHABLE';
    setNode('core', 'unknown', 'UNKNOWN');
    setNode('host', 'bad', 'OFFLINE');
    setAssistantState('HOST OFFLINE / UNREACHABLE', 'Reconnection in progress...');
  }
}

async function pollAudit() {
  try {
    if (!currentSession || document.hidden) return;
    const stream = document.getElementById('hud-audit-stream');
    if (!currentDevice?.permissions?.includes('device:manage:execute')) {
      stream.replaceChildren();
      const line = document.createElement('div');
      line.className = 'audit-line';
      line.textContent = '[AUTH] DEVICE_MANAGE permission required';
      stream.appendChild(line);
      return;
    }
    const res = await window.JarvisDeviceCrypto.signedFetch('/api/audit');
    if (!res.ok) return;
    const data = await res.json();
    stream.replaceChildren();
    (data.records || []).slice(-6).reverse().forEach((r) => {
      const line = document.createElement('div');
      line.className = 'audit-line';
      line.innerText = `[${r.eventType}] ${JSON.stringify(r.details).substring(0, 48)}...`;
      stream.appendChild(line);
    });
  } catch {
    // ignore
  }
}

// Real microphone level metering. The analyser only reads levels locally for the
// display: audio is never recorded, stored, uploaded, or routed to speakers.
// The meter runs only while a user-started voice capture is active and the mic
// is not muted; if it cannot start, the canvas says so instead of faking a level.
let audioMeter = null;
let audioMeterToken = 0;

async function startAudioMeter() {
  if (audioMeter || isMicMuted || document.body.classList.contains('reduced-motion')) return;
  if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') return;
  const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextCtor) return;
  const token = ++audioMeterToken;
  let stream = null;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    if (token !== audioMeterToken || !isListening || isMicMuted) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    const context = new AudioContextCtor();
    const analyser = context.createAnalyser();
    analyser.fftSize = 256;
    context.createMediaStreamSource(stream).connect(analyser);
    audioMeter = { stream, context, analyser, samples: new Uint8Array(analyser.fftSize) };
  } catch {
    if (stream) stream.getTracks().forEach((track) => track.stop());
    audioMeter = null;
  }
}

function stopAudioMeter() {
  audioMeterToken++;
  if (!audioMeter) return;
  const meter = audioMeter;
  audioMeter = null;
  meter.stream.getTracks().forEach((track) => track.stop());
  meter.context.close().catch(() => { /* already closed */ });
}

// Backstop: release the microphone meter whenever capture is no longer active,
// including recognizer error paths and reduced-motion mode (which halts drawing).
setInterval(() => { if (!isListening || isMicMuted) stopAudioMeter(); }, 1000);

function initWaveformCanvas() {
  const canvas = document.getElementById('waveform-canvas');
  if (!canvas) return;
  if (animationFrameId !== null) cancelAnimationFrame(animationFrameId);
  const ctx = canvas.getContext('2d');
  let step = 0;
  let lastFrame = 0;

  function draw(now) {
    if (document.body.classList.contains('reduced-motion')) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      stopAudioMeter();
      animationFrameId = null;
      return;
    }
    animationFrameId = requestAnimationFrame(draw);
    if (now - lastFrame < 33) return; // ~30 fps is enough and keeps CPU low on the laptop
    lastFrame = now;
    if (!isListening) stopAudioMeter();

    const width = canvas.width;
    const height = canvas.height;
    const mid = height / 2;
    ctx.clearRect(0, 0, width, height);
    ctx.lineWidth = 1.5;
    ctx.beginPath();

    if (isListening && audioMeter) {
      // Real input: plot the actual time-domain samples from the microphone analyser.
      ctx.strokeStyle = '#ffb347';
      audioMeter.analyser.getByteTimeDomainData(audioMeter.samples);
      const samples = audioMeter.samples;
      for (let i = 0; i < samples.length; i++) {
        const x = (i / (samples.length - 1)) * width;
        const y = mid + ((samples[i] - 128) / 128) * (mid - 4);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
    } else if (isListening) {
      // Capturing, but no level data is available: show a flat line and say so.
      ctx.strokeStyle = 'rgba(255, 190, 60, 0.7)';
      ctx.setLineDash([4, 6]);
      ctx.moveTo(0, mid);
      ctx.lineTo(width, mid);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(255, 190, 60, 0.85)';
      ctx.font = '10px monospace';
      ctx.textAlign = 'center';
      ctx.fillText('CAPTURING - NO LEVEL DATA', width / 2, mid - 8);
    } else {
      // Idle: a low-amplitude decorative ambient line. It is not telemetry.
      ctx.strokeStyle = 'rgba(0, 229, 255, 0.4)';
      for (let x = 0; x < width; x += 4) {
        const y = mid + Math.sin((x + step) * 0.05) * Math.cos((x - step) * 0.03) * 6;
        if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
      step += 1.5;
    }
  }
  animationFrameId = requestAnimationFrame(draw);
}
