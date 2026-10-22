// JARVIS Cinematic HUD & Push-To-Talk Engine
let currentDevice = null;
let currentSession = null;
let isMicMuted = false;
let isListening = false;
let speechRecognizer = null;
let audioContext = null;
let animationFrameId = null;

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
    document.getElementById('reactor-container').classList.remove('listening');
    document.getElementById('btn-ptt').classList.remove('active');
  };
}

function startVoiceCapture() {
  if (isMicMuted) {
    alert('Microphone is muted by privacy control. Unmute MIC to use voice commands.');
    return;
  }
  if (isListening) return;

  isListening = true;
  if (speechRecognizer) {
    try {
      speechRecognizer.start();
    } catch (e) {
      // recognition might already be active
    }
  } else {
    // Fallback prompt if Speech API not present
    setAssistantState('SPEECH API UNAVAILABLE', 'Using high-speed terminal input mode.');
  }
}

function stopVoiceCapture() {
  if (!isListening) return;
  isListening = false;
  if (speechRecognizer) {
    try {
      speechRecognizer.stop();
    } catch (e) {
      // ignore
    }
  }
  setAssistantState('CONFIRM DIRECTIVE', 'Verify transcribed text before dispatch.');
}

function cancelVoiceCapture() {
  isListening = false;
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
  setAssistantState('PROCESSING DIRECTIVE...', 'Evaluating via Policy Gateway...');
  addFeedItem('directive', text);

  try {
    const res = await fetch('/api/request', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-session-id': currentSession,
      },
      body: JSON.stringify({ text }),
    });

    const data = await res.json();

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
  card.id = `hud-appr-${approvalId}`;
  card.innerHTML = `
    <div style="font-weight:700; color:#fff;">DIRECTIVE: ${requestText}</div>
    <div style="color:var(--hud-warn); font-size:11px; margin:4px 0;">${message}</div>
    <div style="display:flex; gap:6px; margin-top:8px;">
      <button class="hud-btn hud-btn-cyan" onclick="resolveHudApproval('${approvalId}', true)">CONFIRM & EXECUTE</button>
      <button class="hud-btn hud-btn-danger" onclick="resolveHudApproval('${approvalId}', false)">DENY</button>
    </div>
  `;
  slot.appendChild(card);
  updateApprovalCountBadge();
}

async function resolveHudApproval(approvalId, approved) {
  const endpoint = approved ? '/api/approval/approve' : '/api/approval/reject';
  setAssistantState('RESOLVING APPROVAL...', 'Authenticating session...');

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-session-id': currentSession,
      },
      body: JSON.stringify({ approvalId }),
    });
    const result = await res.json();

    const card = document.getElementById(`hud-appr-${approvalId}`);
    if (card) card.remove();
    updateApprovalCountBadge();

    if (approved) {
      setAssistantState('APPROVED & VERIFIED', result.message);
      addFeedItem('success', `Approved Action: ${result.message}`, result.data);
    } else {
      setAssistantState('DIRECTIVE REJECTED', 'Action was rejected by operator.');
      addFeedItem('failed', 'Directive rejected.');
    }
  } catch (err) {
    alert('Failed to resolve approval: ' + err.message);
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

  const timeStr = new Date().toLocaleTimeString();
  let html = `<span class="task-time">[${timeStr}]</span> <strong>${message}</strong>`;
  if (details) {
    html += `<pre style="font-size:10px; color:var(--text-muted); margin-top:4px;">${JSON.stringify(details, null, 2)}</pre>`;
  }
  item.innerHTML = html;
  feed.insertBefore(item, feed.firstChild);
}

async function ensureEnrolledDevice() {
  try {
    const res = await fetch('/api/hud/session', { method: 'POST' });
    const data = await res.json();
    if (data.sessionId && data.device) {
      currentSession = data.sessionId;
      currentDevice = data.device;
      document.getElementById('hud-device-name').innerText = currentDevice.name;
      document.getElementById('hud-device-id').innerText = currentDevice.id;
      document.getElementById('enclave-tag').innerText = 'ENROLLED & ACTIVE';
    }
  } catch (err) {
    console.error('Failed to initialize HUD enclave session:', err);
  }
}

async function pollStatus() {
  try {
    const res = await fetch('/api/status');
    const data = await res.json();
    if (data.status === 'ONLINE') {
      document.getElementById('core-status-dot').style.background = 'var(--cyan-glow)';
      document.getElementById('tel-audit').innerText = data.auditIntegrity?.valid ? 'CHAIN OK' : 'TAMPER DETECTED';
    }
  } catch {
    document.getElementById('core-status-dot').style.background = 'var(--hud-danger)';
    document.getElementById('tel-host').innerText = 'OFFLINE';
    setAssistantState('HOST OFFLINE / UNREACHABLE', 'Reconnection in progress...');
  }
}

async function pollAudit() {
  try {
    const res = await fetch('/api/audit');
    const data = await res.json();
    const stream = document.getElementById('hud-audit-stream');
    stream.innerHTML = '';
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
