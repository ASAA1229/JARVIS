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
let isHandsFreeEnabled = false;
let isWaitingForWakeCommand = false;
let isSpeaking = false;
let speechOutputEnabled = true;
let speechSynthesisAvailable = 'speechSynthesis' in window;
let handsFreeEnabled = false;
let handsFreeStandby = false;
let handsFreeRecognizer = null;
let handsFreeRestartTimer = null;

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
  const reactorCore = document.getElementById('reactor-core');

  // Click-to-toggle voice capture: a normal click must not stop recognition immediately.
  const toggleVoiceCapture = () => {
    if (isListening) stopVoiceCapture();
    else startVoiceCapture();
  };
  btnPtt.addEventListener('click', toggleVoiceCapture);
  reactorCore.addEventListener('click', toggleVoiceCapture);

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
    if (!speechOutputEnabled && speechSynthesisAvailable) { window.speechSynthesis.cancel(); isSpeaking = false; }
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
    handsFreeStandby = true;
    btnHandsFreePause.textContent = 'PAUSE LISTENING';
    btnHandsFreePause.setAttribute('aria-pressed', 'true');
    startHandsFreeStandby();
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
  return phrases.some((phrase) => normalized.includes(phrase) || normalized === phrase);
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
  btnToggle.textContent = handsFreeEnabled ? 'DISABLE HANDS-FREE' : 'ENABLE HANDS-FREE';
  btnToggle.setAttribute('aria-pressed', String(handsFreeEnabled));
  const pauseLabel = handsFreeStandby ? 'PAUSE LISTENING' : 'RESUME LISTENING';
  btnPause.textContent = pauseLabel;
  btnPause.disabled = !handsFreeEnabled;
  btnPause.setAttribute('aria-pressed', String(handsFreeStandby));
}

function stopHandsFreeStandby() {
  if (handsFreeRestartTimer) {
    clearTimeout(handsFreeRestartTimer);
    handsFreeRestartTimer = null;
  }
  if (handsFreeRecognizer) {
    try { handsFreeRecognizer.stop(); } catch (error) { /* no-op */ }
    handsFreeRecognizer = null;
  }
}

function enableWakeDetection() {
  if (isMicMuted) {
    setAssistantState('PRIVACY MODE — MIC MUTED', 'Unmute before enabling hands-free listening.');
    return;
  }
  if (!speechRecognitionConstructor) {
    setAssistantState(window.isSecureContext ? 'SPEECH API UNAVAILABLE' : 'SECURE CONTEXT REQUIRED', speechUnavailableReason || 'Use the text input field; no microphone capture was started.');
    return;
  }
  handsFreeEnabled = true;
  handsFreeStandby = true;
  updateHandsFreeButtons();
  startHandsFreeStandby();
}

function disableWakeDetection() {
  handsFreeEnabled = false;
  handsFreeStandby = false;
  stopHandsFreeStandby();
  if (isListening) {
    cancelVoiceCapture();
  }
  updateHandsFreeButtons();
  setAssistantState('HANDS-FREE DISABLED', 'Wake phrase detection is off. Push-to-talk remains available.');
}

function startHandsFreeStandby() {
  if (!handsFreeEnabled || !speechRecognitionConstructor) return;
  stopHandsFreeStandby();
  const recognizer = new speechRecognitionConstructor();
  recognizer.continuous = true;
  recognizer.interimResults = false;
  recognizer.lang = 'en-US';

  recognizer.onstart = () => {
    if (!handsFreeEnabled || !handsFreeStandby) return;
    setAssistantState('STANDBY', 'Listening for wake phrase…');
  };

  recognizer.onresult = (event) => {
    if (!handsFreeEnabled || !handsFreeStandby || isSubmitting) return;
    let transcript = '';
    for (let index = 0; index < event.results.length; index++) {
      transcript += event.results[index][0].transcript;
    }
    const normalized = normalizeSpeechText(transcript);
    if (!normalized) return;

    if (isStopPhrase(normalized)) {
      handleHandsFreeStop();
      return;
    }

    if (isWakePhrase(normalized)) {
      const wakePatterns = [/\\bhey jarvis\\b/, /\\bhello jarvis\\b/, /\\bhi jarvis\\b/, /\\bi am here\\b/, /\\bim here\\b/];
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
    if (!handsFreeEnabled) return;
    if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
      setAssistantState('MICROPHONE DENIED', 'Allow microphone access for this site in browser settings, then enable listening again.');
      disableWakeDetection();
      return;
    }
    if (event.error === 'audio-capture') {
      setAssistantState('MICROPHONE UNAVAILABLE', 'Another app may be using the microphone, or no input device is available.');
    } else if (event.error === 'network') {
      setAssistantState('SPEECH SERVICE UNAVAILABLE', 'Browser speech recognition could not reach its recognition service. Check internet access or use text input.');
    } else if (event.error === 'no-speech') {
      setAssistantState('NO SPEECH DETECTED', 'I did not hear speech. Check the selected microphone and try again.');
    } else {
      setAssistantState('VOICE RECOGNITION ERROR', `Recognition failed: ${event.error}. You can retry or use text input.`);
    }
    if (handsFreeStandby && handsFreeEnabled) {
      if (handsFreeRestartTimer) clearTimeout(handsFreeRestartTimer);
      handsFreeRestartTimer = setTimeout(() => {
        handsFreeRestartTimer = null;
        if (handsFreeEnabled && handsFreeStandby) startHandsFreeStandby();
      }, 900);
    }
  };

  recognizer.onend = () => {
    if (!handsFreeEnabled || !handsFreeStandby) return;
    handsFreeRecognizer = null;
    handsFreeRestartTimer = setTimeout(() => {
      if (handsFreeEnabled && handsFreeStandby) startHandsFreeStandby();
    }, 400);
  };

  handsFreeRecognizer = recognizer;
  try {
    recognizer.start();
  } catch (error) {
    handsFreeRecognizer = null;
    if (handsFreeEnabled && handsFreeStandby) {
      handsFreeRestartTimer = setTimeout(() => {
        if (handsFreeEnabled && handsFreeStandby) startHandsFreeStandby();
      }, 800);
    }
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
  if (handsFreeEnabled) startHandsFreeStandby();
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

function createSpeechRecognizer(captureGeneration) {
  const recognizer = new speechRecognitionConstructor();
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
    if (captureGeneration !== voiceCaptureGeneration || discardVoiceResult || isMicMuted || isSpeaking) return;
    if (isHandsFreeEnabled) {
      const finalResult = event.results[event.results.length - 1];
      if (!finalResult || !finalResult.isFinal) return;
      handleHandsFreeTranscript(finalResult[0].transcript);
      return;
    }
    let transcript = '';
    for (let i = 0; i < event.results.length; i++) transcript += event.results[i][0].transcript + ' ';
    transcript = transcript.trim();
    if (!transcript) return;
    document.getElementById('transcript-input').value = transcript;
    document.getElementById('transcript-box').classList.remove('hidden');
  };

  recognizer.onerror = (event) => {
    if (captureGeneration !== voiceCaptureGeneration) return;
    console.error('Speech recognition error:', event.error);
    if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
      cancelVoiceCapture();
      disableHandsFree();
      setAssistantState('MICROPHONE PERMISSION REQUIRED', 'Allow microphone access for this site in browser settings, then retry voice input.');
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
    setAssistantState('SPEECH ENGINE ERROR', `Recognition failed: ${event.error}`);
  };

  recognizer.onend = () => {
    if (captureGeneration !== voiceCaptureGeneration) return;
    isListening = false;
    document.getElementById('btn-ptt').setAttribute('aria-pressed', 'false');
    if (voiceTimeoutId) {
      clearTimeout(voiceTimeoutId);
      voiceTimeoutId = null;
    }
    document.getElementById('reactor-container').classList.remove('listening');
    document.getElementById('btn-ptt').classList.remove('active');
    if (discardVoiceResult) {
      document.getElementById('transcript-input').value = '';
      document.getElementById('transcript-box').classList.add('hidden');
      discardVoiceResult = false;
    }
    if (isHandsFreeEnabled && !isMicMuted && !isSpeaking) scheduleHandsFreeRestart();
  };

  return recognizer;
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
      void speakResponse('Yes? I am listening.');
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
  if (handsFreeRestartTimer) clearTimeout(handsFreeRestartTimer);
  handsFreeRestartTimer = setTimeout(() => {
    handsFreeRestartTimer = null;
    if (!isHandsFreeEnabled || isMicMuted || isSpeaking || isListening || isSubmitting || !speechRecognitionConstructor) return;
    startVoiceCapture();
  }, 350);
}

function enableHandsFree() {
  if (isMicMuted) { setAssistantState('MIC MUTED', 'Unmute the microphone before enabling hands-free mode.'); return; }
  if (!speechRecognitionConstructor) { setAssistantState('SPEECH API UNAVAILABLE', speechUnavailableReason || 'Use push-to-talk or text input in this browser.'); return; }
  isHandsFreeEnabled = true;
  isWaitingForWakeCommand = false;
  const button = document.getElementById('btn-hands-free');
  if (button) { button.textContent = 'HANDS-FREE: ON'; button.setAttribute('aria-pressed', 'true'); }
  setAssistantState('HANDS-FREE STANDBY', 'Listening for “Hey JARVIS”. Microphone remains active until you disable hands-free.');
  startVoiceCapture();
}

function disableHandsFree() {
  isHandsFreeEnabled = false;
  isWaitingForWakeCommand = false;
  if (handsFreeRestartTimer) { clearTimeout(handsFreeRestartTimer); handsFreeRestartTimer = null; }
  const button = document.getElementById('btn-hands-free');
  if (button) { button.textContent = 'HANDS-FREE: OFF'; button.setAttribute('aria-pressed', 'false'); }
  cancelVoiceCapture();
  if (speechSynthesisAvailable) window.speechSynthesis.cancel();
  isSpeaking = false;
  setAssistantState(isMicMuted ? 'PRIVACY MODE — MIC MUTED' : 'STANDBY', 'Hands-free disabled. Microphone will not listen until you activate voice again.');
}

function startVoiceCapture() {
  if (isMicMuted) {
    setAssistantState('PRIVACY MODE — MIC MUTED', 'Unmute only when you want to start voice capture.');
    return;
  }
  if (isListening) return;
  if (!speechRecognitionConstructor) {
    setAssistantState(window.isSecureContext ? 'SPEECH API UNAVAILABLE' : 'SECURE CONTEXT REQUIRED',
      speechUnavailableReason || 'Use the text input field; no audio capture was started.');
    return;
  }

  discardVoiceResult = false;
  document.getElementById('transcript-input').value = '';
  document.getElementById('transcript-box').classList.add('hidden');
  isListening = true;
  document.getElementById('btn-ptt').setAttribute('aria-pressed', 'true');
  const captureGeneration = ++voiceCaptureGeneration;
  try {
    speechRecognizer = createSpeechRecognizer(captureGeneration);
    speechRecognizer.start();
    voiceTimeoutId = setTimeout(() => {
      if (!isListening || captureGeneration !== voiceCaptureGeneration) return;
      stopVoiceCapture(isHandsFreeEnabled ? 'HANDS-FREE STANDBY' : 'VOICE TIME LIMIT', isHandsFreeEnabled ? 'Refreshing the browser recognition session.' : 'The 15-second capture limit was reached. Review the transcript before sending.');
    }, 15000);
  } catch (e) {
    isListening = false;
    document.getElementById('btn-ptt').setAttribute('aria-pressed', 'false');
    voiceCaptureGeneration++;
    if (voiceTimeoutId) clearTimeout(voiceTimeoutId);
    voiceTimeoutId = null;
    speechRecognizer = null;
    setAssistantState('VOICE START FAILED', 'The browser could not start speech recognition. Use text input instead.');
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
    } catch (e) {
      setAssistantState('VOICE STOP UNCERTAIN', 'Check microphone indicator and use Cancel if capture continues.');
    }
  }
  setAssistantState(label, detail);
}

function cancelVoiceCapture() {
  isListening = false;
  document.getElementById('btn-ptt').setAttribute('aria-pressed', 'false');
  discardVoiceResult = true;
  voiceCaptureGeneration++;
  if (voiceTimeoutId) {
    clearTimeout(voiceTimeoutId);
    voiceTimeoutId = null;
  }
  if (speechRecognizer) {
    try {
      speechRecognizer.abort();
    } catch (e) {
      // ignore
    }
  }
  document.getElementById('reactor-container').classList.remove('listening');
  document.getElementById('btn-ptt').classList.remove('active');
  document.getElementById('transcript-input').value = '';
  document.getElementById('transcript-box').classList.add('hidden');
  setAssistantState('IDLE — READY', 'Ready for directive.');
}

function handleTextSubmit() {
  const input = document.getElementById('hud-text-input');
  const val = input.value.trim();
  if (!val) return;
  void submitDirective(val);
}

async function submitDirective(text) {
  if (!currentSession) {
    setAssistantState('SESSION UNAVAILABLE', 'Secure device enrollment is required before submitting directives.');
    addFeedItem('failed', 'Directive not sent: no authenticated session.');
    return;
  }
  if (isSubmitting) return;
  isSubmitting = true;
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

  try {
    const res = await window.JarvisDeviceCrypto.signedFetch('/api/request', {
      method: 'POST',
      body: { text },
      signal: controller.signal,
    });
    const data = await readApiResponse(res);
    if (data.approvalId && data.state === 'AWAITING_APPROVAL') {
      setAssistantState('AWAITING CONSENT', data.message);
      speakResponse(data.message || 'I need your approval before performing that action.');
      renderApprovalCard(data.approvalId, data.taskId, text, data.message);
      addFeedItem('pending', `Approval Required: ${data.message}`);
    } else if (data.state === 'COMPLETED' &&
        data.outcome === 'VERIFIED_SUCCESS' && data.verified === true) {
      setAssistantState('DIRECTIVE EXECUTED', data.message);
      addFeedItem('success', `Verified Result: ${data.message}`, data.data);
      speakResponse(data.message || 'The action completed successfully.');
    } else if (data.state === 'PARTIAL' || data.state === 'AWAITING_RECOVERY' ||
        data.outcome === 'UNCERTAIN' || data.verified === false) {
      setAssistantState('OUTCOME NOT VERIFIED', data.message);
      addFeedItem('pending', `Outcome not fully verified: ${data.message}`, data.data);
      speakResponse(data.message || 'I could not fully verify the outcome.');
    } else {
      setAssistantState('EXECUTION DENIED / FAILED', data.message || data.error);
      addFeedItem('failed', `Denied: ${data.message || data.error}`);
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


async function speakResponse(message) {
  const text = String(message || '').trim();
  if (!text || isMicMuted || !speechOutputEnabled) return;
  isSpeaking = false;
  if (currentSession && window.JarvisDeviceCrypto?.signedFetch) {
    try {
      const response = await window.JarvisDeviceCrypto.signedFetch('/api/voice/synthesize', {
        method: 'POST', body: { text: text.slice(0, 1200) },
      });
      if (response.ok) {
        const blob = await response.blob();
        if (blob.type.includes('audio/wav') && blob.size > 44) {
          const url = URL.createObjectURL(blob);
          const audio = new Audio(url);
          const releaseUrl = () => URL.revokeObjectURL(url);
          audio.addEventListener('ended', releaseUrl, { once: true });
          audio.addEventListener('error', releaseUrl, { once: true });
          try {
            await audio.play();
            isSpeaking = true;
            audio.addEventListener('ended', () => { isSpeaking = false; if (isHandsFreeEnabled && !isMicMuted) scheduleHandsFreeRestart(); }, { once: true });
            return;
          } catch (playError) {
            releaseUrl();
            throw playError;
          }
        }
      }
    } catch (error) {
      console.warn('Local neural TTS unavailable; trying browser speech.', error);
    }
  }
  if ('speechSynthesis' in window && 'SpeechSynthesisUtterance' in window) {
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    isSpeaking = true;
    utterance.lang = 'en-GB';
    utterance.rate = 0.92;
    utterance.pitch = 0.9;
    utterance.onend = () => { isSpeaking = false; if (isHandsFreeEnabled && !isMicMuted) scheduleHandsFreeRestart(); };
    utterance.onerror = () => { isSpeaking = false; if (isHandsFreeEnabled && !isMicMuted) scheduleHandsFreeRestart(); };
    window.speechSynthesis.speak(utterance);
  }
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
  const endpoint = approved ? '/api/approval/approve' : '/api/approval/reject';
  setAssistantState('RESOLVING APPROVAL...', 'Checking server authorization and task state...');

  if (!currentSession) {
    setAssistantState('SESSION UNAVAILABLE', 'Secure device enrollment is required before approvals can be submitted.');
    return;
  }

  try {
    const res = await window.JarvisDeviceCrypto.signedFetch(endpoint, {
      method: 'POST',
      body: { approvalId },
    });
    const result = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(result.error || 'Approval request failed with HTTP ' + res.status);
    }
    if (!approved && result.success !== true) {
      throw new Error(result.message || result.error || 'Server did not confirm the rejection');
    }

    if (!approved) {
      const card = document.getElementById('hud-appr-' + approvalId);
      if (card) card.remove();
      updateApprovalCountBadge();
      setAssistantState('DIRECTIVE REJECTED', 'The server confirmed that the action was rejected.');
      addFeedItem('failed', 'Directive rejected by operator.');
      speakResponse('The directive was rejected.');
      return;
    }

    if (result.state === 'COMPLETED' && result.success === true &&
        result.outcome === 'VERIFIED_SUCCESS' && result.verified === true) {
      const card = document.getElementById('hud-appr-' + approvalId);
      if (card) card.remove();
      updateApprovalCountBadge();
      setAssistantState('TASK COMPLETED', result.message || 'The server reports the task completed; review evidence before relying on the result.');
      addFeedItem('success', 'Task state: COMPLETED — ' + (result.message || 'No result details supplied'), result.data);
      speakResponse(result.message || 'The approved task completed and was verified.');
    } else if (['FAILED', 'REJECTED', 'EXPIRED', 'CANCELLED', 'PARTIAL', 'AWAITING_RECOVERY'].includes(result.state)) {
      const card = document.getElementById('hud-appr-' + approvalId);
      if (card) card.remove();
      updateApprovalCountBadge();
      setAssistantState('TASK DID NOT COMPLETE', result.message || String(result.state));
      addFeedItem('failed', 'Approval was processed but the task did not complete: ' + String(result.state), result.data);
      speakResponse(result.message || 'The approved task did not complete.');
    } else {
      setAssistantState('APPROVAL PROCESSED — NOT COMPLETE', result.message || 'Approval was processed but execution is not verified complete.');
      addFeedItem('pending', 'Approval processed; task state: ' + String(result.state || 'UNKNOWN'));
    }
  } catch (err) {
    setAssistantState('APPROVAL STATUS UNKNOWN', err instanceof Error ? err.message : 'Approval request failed');
    addFeedItem('failed', 'Approval state could not be confirmed. Refresh status before retrying.');
    speakResponse(err instanceof Error ? err.message : 'Approval status could not be confirmed.');
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
}

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
    setAssistantState('SESSION UNAVAILABLE', err instanceof Error ? err.message : 'Enroll this browser through the companion UI first.');
  }
}

async function pollStatus() {
  try {
    const res = await fetch('/api/status');
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error('Status request failed');
    if (data.status === 'ONLINE') {
      document.getElementById('core-status-dot').classList.remove('degraded');
      document.getElementById('tel-audit').innerText = 'CORE HEALTHY';
    } else if (data.status === 'DEGRADED') {
      document.getElementById('core-status-dot').classList.add('degraded');
      document.getElementById('tel-audit').innerText = 'DEGRADED';
      setAssistantState('CORE DEGRADED', 'Security state needs attention. State-changing tasks must remain blocked.');
    } else {
      throw new Error('Unknown server status response');
    }
  } catch {
    document.getElementById('core-status-dot').classList.add('degraded');
    document.getElementById('tel-host').innerText = 'OFFLINE';
    setAssistantState('HOST OFFLINE / UNREACHABLE', 'Reconnection in progress...');
  }
}

async function pollAudit() {
  try {
    if (!currentSession) return;
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

function initWaveformCanvas() {
  const canvas = document.getElementById('waveform-canvas');
  if (!canvas) return;
  if (animationFrameId !== null) cancelAnimationFrame(animationFrameId);
  const ctx = canvas.getContext('2d');
  let step = 0;

  function draw() {
    if (document.body.classList.contains('reduced-motion')) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      animationFrameId = null;
      return;
    }
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = isListening ? '#ff0055' : 'rgba(0, 229, 255, 0.4)';

    ctx.beginPath();
    const width = canvas.width;
    const height = canvas.height;
    const mid = height / 2;

    for (let x = 0; x < width; x += 4) {
      const amp = isListening ? 18 : 6;
      const y = mid + Math.sin((x + step) * 0.05) * Math.cos((x - step) * 0.03) * amp;
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    step += isListening ? 4 : 1.5;
    animationFrameId = requestAnimationFrame(draw);
  }
  draw();
}
