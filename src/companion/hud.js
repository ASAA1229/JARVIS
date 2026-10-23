// JARVIS Cinematic HUD & Push-To-Talk Engine
let currentDevice = null;
let currentSession = null;
let isMicMuted = false;
let isListening = false;
let speechRecognizer = null;
let audioContext = null;
let animationFrameId = null;
let voiceTimeoutId = null;
let discardVoiceResult = false;

document.addEventListener('DOMContentLoaded', async () => {
  initSpeechRecognition();
  setupEventListeners();
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
  const btnMotion = document.getElementById('btn-toggle-motion');
  const reactorCore = document.getElementById('reactor-core');

  // Push to talk buttons
  btnPtt.addEventListener('mousedown', startVoiceCapture);
  btnPtt.addEventListener('mouseup', stopVoiceCapture);
  btnPtt.addEventListener('touchstart', (e) => { e.preventDefault(); startVoiceCapture(); });
  btnPtt.addEventListener('touchend', (e) => { e.preventDefault(); stopVoiceCapture(); });

  reactorCore.addEventListener('click', () => {
    if (isListening) stopVoiceCapture();
    else startVoiceCapture();
  });

  // Keyboard shortcut: Spacebar hold for push-to-talk
  let spacePressed = false;
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && !spacePressed && document.activeElement !== textInput && document.activeElement !== document.getElementById('transcript-input')) {
      spacePressed = true;
      e.preventDefault();
      startVoiceCapture();
    }
    if (e.code === 'Escape') {
      cancelVoiceCapture();
    }
  });

  window.addEventListener('keyup', (e) => {
    if (e.code === 'Space' && spacePressed) {
      spacePressed = false;
      e.preventDefault();
      stopVoiceCapture();
    }
  });

  // Send terminal text input
  btnSend.addEventListener('click', handleTextSubmit);
  textInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleTextSubmit();
  });

  // Transcript confirmation actions
  document.getElementById('btn-transcript-submit').addEventListener('click', () => {
    const val = document.getElementById('transcript-input').value.trim();
    document.getElementById('transcript-box').classList.add('hidden');
    if (val) submitDirective(val);
  });

  document.getElementById('btn-transcript-cancel').addEventListener('click', () => {
    document.getElementById('transcript-box').classList.add('hidden');
    setAssistantState('IDLE — DIRECTIVE DISCARDED', 'Ready for new instruction.');
  });

  // Privacy Mute Toggle
  btnMute.addEventListener('click', () => {
    isMicMuted = !isMicMuted;
    if (isMicMuted) {
      cancelVoiceCapture();
      btnMute.innerText = 'MIC: MUTED';
      btnMute.classList.add('muted');
      setAssistantState('PRIVACY MODE — MIC MUTED', 'Microphone hardware access disabled.');
    } else {
      btnMute.innerText = 'MIC: ARMED';
      btnMute.classList.remove('muted');
      setAssistantState('STANDBY', 'Microphone armed for push-to-talk.');
    }
  });

  // Reduced Motion Toggle
  btnMotion.addEventListener('click', () => {
    document.body.classList.toggle('reduced-motion');
    const isReduced = document.body.classList.contains('reduced-motion');
    btnMotion.innerText = `REDUCED MOTION: ${isReduced ? 'ON' : 'OFF'}`;
  });

  // Quick Directive Chips
  document.querySelectorAll('.hud-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const cmd = chip.getAttribute('data-cmd');
      textInput.value = cmd;
      submitDirective(cmd);
    });
  });
}

function initSpeechRecognition() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    console.warn('SpeechRecognition API not available in browser. Push-to-talk will use text input fallback.');
    return;
  }

  speechRecognizer = new SpeechRecognition();
  speechRecognizer.continuous = false;
  speechRecognizer.interimResults = true;
  speechRecognizer.lang = 'en-US';

  speechRecognizer.onstart = () => {
    setAssistantState('LISTENING...', 'Capturing voice command...');
    document.getElementById('reactor-container').classList.add('listening');
    document.getElementById('btn-ptt').classList.add('active');
  };

  speechRecognizer.onresult = (event) => {
    if (discardVoiceResult || isMicMuted) return;
    let transcript = '';
    for (let i = 0; i < event.results.length; i++) {
      transcript += event.results[i][0].transcript;
    }
    document.getElementById('transcript-input').value = transcript;
    document.getElementById('transcript-box').classList.remove('hidden');
  };

  speechRecognizer.onerror = (event) => {
    console.error('Speech recognition error:', event.error);
    setAssistantState('SPEECH ENGINE ERROR', `Recognition failed: ${event.error}`);
    cancelVoiceCapture();
  };

  speechRecognizer.onend = () => {
    isListening = false;
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
  };
}

function startVoiceCapture() {
  if (isMicMuted) {
    setAssistantState('PRIVACY MODE — MIC MUTED', 'Unmute only when you want to start voice capture.');
    return;
  }
  if (isListening) return;
  if (!speechRecognizer) {
    setAssistantState('SPEECH API UNAVAILABLE', 'Use the text input field; no audio capture was started.');
    return;
  }

  discardVoiceResult = false;
  isListening = true;
  try {
    speechRecognizer.start();
    voiceTimeoutId = setTimeout(() => {
      if (!isListening) return;
      setAssistantState('VOICE TIME LIMIT', 'The 15-second capture limit was reached. Review the transcript before sending.');
      stopVoiceCapture();
    }, 15000);
  } catch (e) {
    isListening = false;
    if (voiceTimeoutId) clearTimeout(voiceTimeoutId);
    voiceTimeoutId = null;
    setAssistantState('VOICE START FAILED', 'The browser could not start speech recognition. Use text input instead.');
  }
}

function stopVoiceCapture() {
  if (!isListening) return;
  isListening = false;
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
  setAssistantState('CONFIRM DIRECTIVE', 'Verify or edit the transcript before dispatch.');
}

function cancelVoiceCapture() {
  isListening = false;
  discardVoiceResult = true;
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
  document.getElementById('transcript-box').classList.add('hidden');
  setAssistantState('IDLE — READY', 'Ready for directive.');
}

function handleTextSubmit() {
  const input = document.getElementById('hud-text-input');
  const val = input.value.trim();
  if (!val) return;
  input.value = '';
  submitDirective(val);
}

async function submitDirective(text) {
  if (!currentSession) {
    setAssistantState('SESSION UNAVAILABLE', 'Secure device enrollment is required before submitting directives.');
    addFeedItem('failed', 'Directive not sent: no authenticated session.');
    return;
  }
  setAssistantState('PROCESSING DIRECTIVE...', 'Evaluating via Policy Gateway...');
  addFeedItem('directive', text);

  try {
    const res = await window.JarvisDeviceCrypto.signedFetch('/api/request', {
      method: 'POST',
      body: { text },
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Request failed with HTTP ' + res.status);

    if (data.approvalId && data.state === 'AWAITING_APPROVAL') {
      setAssistantState('AWAITING CONSENT', data.message);
      renderApprovalCard(data.approvalId, data.taskId, text, data.message);
      addFeedItem('pending', `Approval Required: ${data.message}`);
    } else if (data.state === 'COMPLETED') {
      setAssistantState('DIRECTIVE EXECUTED', data.message);
      addFeedItem('success', `Verified Result: ${data.message}`, data.data);
    } else {
      setAssistantState('EXECUTION DENIED / FAILED', data.message || data.error);
      addFeedItem('failed', `Denied: ${data.message || data.error}`);
    }
  } catch (err) {
    setAssistantState('COMMUNICATION FAILURE', err.message);
    addFeedItem('failed', `Network error: ${err.message}`);
  }
}

function renderApprovalCard(approvalId, taskId, requestText, message) {
  const slot = document.getElementById('hud-approvals-slot');
  document.getElementById('hud-no-approvals-hint').classList.add('hidden');

  const card = document.createElement('div');
  card.className = 'hud-approval-card';
  card.id = 'hud-appr-' + approvalId;

  const directive = document.createElement('div');
  directive.style.fontWeight = '700';
  directive.style.color = '#fff';
  directive.textContent = 'DIRECTIVE: ' + String(requestText);

  const description = document.createElement('div');
  description.style.color = 'var(--hud-warn)';
  description.style.fontSize = '11px';
  description.style.margin = '4px 0';
  description.textContent = String(message || '');

  const actions = document.createElement('div');
  actions.style.display = 'flex';
  actions.style.gap = '6px';
  actions.style.marginTop = '8px';

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
    if (!result.success) {
      throw new Error(result.message || result.error || 'Server did not confirm the approval transition');
    }

    if (!approved) {
      const card = document.getElementById('hud-appr-' + approvalId);
      if (card) card.remove();
      updateApprovalCountBadge();
      setAssistantState('DIRECTIVE REJECTED', 'The server confirmed that the action was rejected.');
      addFeedItem('failed', 'Directive rejected by operator.');
      return;
    }

    if (result.state === 'COMPLETED') {
      const card = document.getElementById('hud-appr-' + approvalId);
      if (card) card.remove();
      updateApprovalCountBadge();
      setAssistantState('TASK COMPLETED', result.message || 'The server reports the task completed; review evidence before relying on the result.');
      addFeedItem('success', 'Task state: COMPLETED — ' + (result.message || 'No result details supplied'), result.data);
    } else {
      setAssistantState('APPROVAL PROCESSED — NOT COMPLETE', result.message || 'Approval was processed but execution is not verified complete.');
      addFeedItem('pending', 'Approval processed; task state: ' + String(result.state || 'UNKNOWN'));
    }
  } catch (err) {
    setAssistantState('APPROVAL STATUS UNKNOWN', err instanceof Error ? err.message : 'Approval request failed');
    addFeedItem('failed', 'Approval state could not be confirmed. Refresh status before retrying.');
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
    pre.style.fontSize = '10px';
    pre.style.color = 'var(--text-muted)';
    pre.style.marginTop = '4px';
    pre.textContent = typeof details === 'string' ? details : JSON.stringify(details, null, 2);
    item.appendChild(pre);
  }
  feed.insertBefore(item, feed.firstChild);
}

async function ensureEnrolledDevice() {
  try {
    const session = await window.JarvisDeviceCrypto.restoreSession();
    currentSession = session.sessionId;
    currentDevice = { id: session.deviceId, name: session.deviceName };
    document.getElementById('hud-device-name').textContent = currentDevice.name;
    document.getElementById('hud-device-id').textContent = currentDevice.id;
    document.getElementById('enclave-tag').textContent = 'ENROLLED & AUTHENTICATED';
    setAssistantState('STANDBY', 'Device-bound session established. Confirm all transcribed directives before execution.');
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
      document.getElementById('core-status-dot').style.background = 'var(--cyan-glow)';
      document.getElementById('tel-audit').innerText = 'AUTH REQUIRED';
    }
  } catch {
    document.getElementById('core-status-dot').style.background = 'var(--hud-danger)';
    document.getElementById('tel-host').innerText = 'OFFLINE';
    setAssistantState('HOST OFFLINE / UNREACHABLE', 'Reconnection in progress...');
  }
}

async function pollAudit() {
  try {
    if (!currentSession) return;
    const res = await fetch('/api/audit', { headers: { 'x-session-id': currentSession } });
    if (!res.ok) return;
    const data = await res.json();
    const stream = document.getElementById('hud-audit-stream');
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
  const ctx = canvas.getContext('2d');
  let step = 0;

  function draw() {
    if (document.body.classList.contains('reduced-motion')) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
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
