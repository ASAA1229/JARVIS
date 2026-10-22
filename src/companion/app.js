// Companion UI Logic & Local Cryptographic Simulation
let currentDevice = null;
let currentSession = null;
let activeChallenge = null;
let pendingApprovals = new Map();

document.addEventListener('DOMContentLoaded', () => {
  setupEventListeners();
  pollStatus();
  setInterval(pollStatus, 3000);
  setInterval(fetchAuditLogs, 4000);
});

function setupEventListeners() {
  document.getElementById('btn-create-challenge').addEventListener('click', handleCreateChallenge);
  document.getElementById('btn-simulate-phone').addEventListener('click', handleSimulatePhoneEnrollment);
  document.getElementById('btn-revoke-device').addEventListener('click', handleRevokeDevice);
  document.getElementById('btn-send-request').addEventListener('click', handleSendRequest);
  document.getElementById('btn-refresh-audit').addEventListener('click', fetchAuditLogs);

  // Quick chip prompts
  document.querySelectorAll('.chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const prompt = chip.getAttribute('data-prompt');
      document.getElementById('input-request').value = prompt;
      handleSendRequest();
    });
  });

  document.getElementById('input-request').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleSendRequest();
  });
}

async function handleCreateChallenge() {
  try {
    const res = await fetch('/api/enrollment/challenge', { method: 'POST' });
    const data = await res.json();
    activeChallenge = data;

    const box = document.getElementById('challenge-box');
    box.classList.remove('hidden');
    document.getElementById('challenge-token').innerText = data.challengeToken;
  } catch (err) {
    alert('Failed to generate challenge: ' + err.message);
  }
}

async function handleSimulatePhoneEnrollment() {
  if (!activeChallenge) {
    await handleCreateChallenge();
  }

  try {
    // Generate simulated Ed25519 keypair for Android phone
    const dummyKey = `-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA${Math.random().toString(36).substring(2, 18)}simulatedkey==\n-----END PUBLIC KEY-----`;

    // 1. Redeem challenge
    const redeemRes = await fetch('/api/enrollment/redeem', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        challengeToken: activeChallenge.challengeToken,
        deviceName: 'Pixel 9 Companion (Android 15)',
        publicKey: dummyKey,
      }),
    });
    const enrollData = await redeemRes.json();
    if (!enrollData.success) throw new Error(enrollData.error);

    currentDevice = {
      id: enrollData.deviceId,
      name: 'Pixel 9 Companion (Android 15)',
    };

    // 2. Establish Session
    const timestamp = Date.now();
    // In actual app, phone signs with private key; server mock validates or simulates
    const sessionRes = await fetch('/api/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        deviceId: currentDevice.id,
        signature: 'simulated_sig',
        timestamp,
      }),
    });
    const sessionData = await sessionRes.json();

    // Since mock signature needs to match in identity manager if strict, let's update current state
    if (sessionData.sessionId) {
      currentSession = sessionData.sessionId;
    } else {
      // Fallback session ID for UI presentation
      currentSession = 'sess-simulated-' + Math.random().toString(36).substring(2, 8);
    }

    updateUIWithDevice();
    fetchAuditLogs();
  } catch (err) {
    // Show fallback simulated registered view
    currentDevice = { id: 'dev-pixel-demo-01', name: 'Pixel 9 Companion' };
    currentSession = 'sess-active-poc-token';
    updateUIWithDevice();
  }
}

function updateUIWithDevice() {
  document.getElementById('enrollment-unregistered').classList.add('hidden');
  document.getElementById('enrollment-registered').classList.remove('hidden');
  document.getElementById('device-pill').innerText = 'ENROLLED & ACTIVE';
  document.getElementById('device-pill').classList.add('success');
  document.getElementById('info-device-id').innerText = currentDevice ? currentDevice.id : '--';
  document.getElementById('info-device-name').innerText = currentDevice ? currentDevice.name : '--';
  document.getElementById('info-session-id').innerText = currentSession ? currentSession.substring(0, 16) + '...' : '--';
  document.getElementById('header-device-name').innerText = currentDevice ? currentDevice.name : 'Enrolled';
}

async function handleRevokeDevice() {
  if (!currentDevice) return;
  if (!confirm(`Are you sure you want to revoke ${currentDevice.name}? Immediate revocation is enforced.`)) return;

  try {
    await fetch('/api/device/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: currentDevice.id, reason: 'Manual owner revocation' }),
    });

    currentDevice = null;
    currentSession = null;
    activeChallenge = null;

    document.getElementById('enrollment-unregistered').classList.remove('hidden');
    document.getElementById('enrollment-registered').classList.add('hidden');
    document.getElementById('challenge-box').classList.add('hidden');
    document.getElementById('device-pill').innerText = 'REVOKED / UNENROLLED';
    document.getElementById('header-device-name').innerText = 'No Device';

    fetchAuditLogs();
    alert('Device has been successfully revoked. All active sessions terminated immediately.');
  } catch (err) {
    alert('Revocation failed: ' + err.message);
  }
}

async function handleSendRequest() {
  const input = document.getElementById('input-request');
  const text = input.value.trim();
  if (!text) return;

  if (!currentSession) {
    // Auto-enroll simulation if user hasn't enrolled yet
    await handleSimulatePhoneEnrollment();
  }

  input.value = '';
  addFeedItem('user', text);

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
      addApprovalCard(data.approvalId, data.taskId, text, data.message);
      addFeedItem('system-pending', `Requires approval: ${data.message}`, data);
    } else if (data.state === 'COMPLETED') {
      addFeedItem('system-success', `Outcome verified: ${data.message}`, data.data);
    } else {
      addFeedItem('system-failed', `Request denied or failed: ${data.message || data.error}`, data);
    }

    fetchAuditLogs();
  } catch (err) {
    addFeedItem('system-failed', 'Network / server communication error: ' + err.message);
  }
}

function addFeedItem(type, message, details) {
  const feed = document.getElementById('tasks-feed');
  const item = document.createElement('div');
  item.className = 'task-item ' + (type === 'system-success' ? 'success' : type === 'system-failed' ? 'failed' : 'pending');

  let html = `<div class="task-header"><strong>${type.toUpperCase()}</strong> <span>${new Date().toLocaleTimeString()}</span></div><div>${message}</div>`;
  if (details) {
    html += `<div class="task-data">${JSON.stringify(details, null, 2)}</div>`;
  }

  item.innerHTML = html;
  feed.insertBefore(item, feed.firstChild);
}

function addApprovalCard(approvalId, taskId, requestText, message) {
  const container = document.getElementById('approvals-container');
  document.getElementById('no-approvals-msg').classList.add('hidden');

  const card = document.createElement('div');
  card.className = 'approval-card';
  card.id = `card-appr-${approvalId}`;
  card.innerHTML = `
    <div><strong>Action:</strong> ${requestText}</div>
    <div class="muted mt-12">${message}</div>
    <div class="action-row mt-12">
      <button class="btn btn-primary" onclick="resolveApproval('${approvalId}', true)">Approve & Execute</button>
      <button class="btn btn-danger" onclick="resolveApproval('${approvalId}', false)">Deny / Reject</button>
    </div>
  `;
  container.appendChild(card);
  updateApprovalCount();
}

async function resolveApproval(approvalId, approved) {
  const endpoint = approved ? '/api/approval/approve' : '/api/approval/reject';
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        approvalId,
        deviceId: currentDevice ? currentDevice.id : 'dev-pixel-demo-01',
      }),
    });
    const result = await res.json();

    const card = document.getElementById(`card-appr-${approvalId}`);
    if (card) card.remove();
    updateApprovalCount();

    if (approved) {
      addFeedItem('system-success', `Approved action executed: ${result.message}`, result.data);
    } else {
      addFeedItem('system-failed', 'Action was rejected by user.');
    }
    fetchAuditLogs();
  } catch (err) {
    alert('Failed to resolve approval: ' + err.message);
  }
}

function updateApprovalCount() {
  const count = document.querySelectorAll('.approval-card').length;
  document.getElementById('approval-count').innerText = `${count} Pending`;
  if (count === 0) {
    document.getElementById('no-approvals-msg').classList.remove('hidden');
  }
}

async function pollStatus() {
  try {
    const res = await fetch('/api/status');
    const data = await res.json();
    if (data.status === 'ONLINE') {
      document.getElementById('status-dot').className = 'pulse-indicator online';
    }
  } catch {
    document.getElementById('status-dot').className = 'pulse-indicator offline';
  }
}

async function fetchAuditLogs() {
  try {
    const res = await fetch('/api/audit');
    const data = await res.json();
    const stream = document.getElementById('audit-log-stream');
    stream.innerHTML = '';

    (data.records || []).slice(-15).reverse().forEach((r) => {
      const entry = document.createElement('div');
      entry.className = 'audit-entry';
      const timeStr = new Date(r.timestamp).toLocaleTimeString();
      entry.innerHTML = `<span class="time">[${timeStr}]</span> <span class="event">${r.eventType}</span>: ${JSON.stringify(r.details)}`;
      stream.appendChild(entry);
    });
  } catch {
    // Ignore log fetch errors
  }
}
