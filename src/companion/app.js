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
  // The previous demo fabricated a public key and fell back to a fake session ID.
  // Never represent a simulated identity as authenticated.
  currentDevice = null;
  currentSession = null;
  setEnrollmentUnavailable('Real device key generation and signed session establishment are not configured yet.');
}

function setEnrollmentUnavailable(message) {
  document.getElementById('enrollment-unregistered').classList.remove('hidden');
  document.getElementById('enrollment-registered').classList.add('hidden');
  document.getElementById('device-pill').textContent = 'SECURE ENROLLMENT REQUIRED';
  document.getElementById('header-device-name').textContent = 'No authenticated device';
  addFeedItem('system-failed', message);
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
      headers: { 
        'Content-Type': 'application/json',
        'x-session-id': currentSession || '',
      },
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
    addFeedItem('system-failed', 'Request not sent: secure device enrollment is not configured.');
    return;
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

    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Request failed with HTTP ' + res.status);

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

  const header = document.createElement('div');
  header.className = 'task-header';
  const label = document.createElement('strong');
  label.textContent = String(type).toUpperCase();
  const time = document.createElement('span');
  time.textContent = new Date().toLocaleTimeString();
  header.append(label, document.createTextNode(' '), time);

  const body = document.createElement('div');
  body.textContent = String(message ?? '');
  item.append(header, body);

  if (details !== undefined && details !== null) {
    const data = document.createElement('pre');
    data.className = 'task-data';
    data.textContent = typeof details === 'string' ? details : JSON.stringify(details, null, 2);
    item.appendChild(data);
  }
  feed.insertBefore(item, feed.firstChild);
}

function addApprovalCard(approvalId, taskId, requestText, message) {
  const container = document.getElementById('approvals-container');
  document.getElementById('no-approvals-msg').classList.add('hidden');

  const card = document.createElement('div');
  card.className = 'approval-card';
  card.id = 'card-appr-' + approvalId;

  const request = document.createElement('div');
  const requestLabel = document.createElement('strong');
  requestLabel.textContent = 'Action: ';
  request.append(requestLabel, document.createTextNode(String(requestText)));

  const description = document.createElement('div');
  description.className = 'muted mt-12';
  description.textContent = String(message || '');

  const actions = document.createElement('div');
  actions.className = 'action-row mt-12';
  const approve = document.createElement('button');
  approve.className = 'btn btn-primary';
  approve.textContent = 'Approve & Execute';
  approve.addEventListener('click', () => resolveApproval(approvalId, true));
  const reject = document.createElement('button');
  reject.className = 'btn btn-danger';
  reject.textContent = 'Deny / Reject';
  reject.addEventListener('click', () => resolveApproval(approvalId, false));
  actions.append(approve, reject);

  card.append(request, description, actions);
  container.appendChild(card);
  updateApprovalCount();
}

async function resolveApproval(approvalId, approved) {
  const endpoint = approved ? '/api/approval/approve' : '/api/approval/reject';
  if (!currentSession) {
    addFeedItem('system-failed', 'Approval unavailable: no authenticated session.');
    return;
  }
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-session-id': currentSession,
      },
      body: JSON.stringify({ approvalId }),
    });
    const result = await res.json().catch(() => ({}));
    if (!res.ok || !result.success) {
      throw new Error(result.error || result.message || 'Approval request failed with HTTP ' + res.status);
    }

    if (!approved) {
      const card = document.getElementById('card-appr-' + approvalId);
      if (card) card.remove();
      updateApprovalCount();
      addFeedItem('system-failed', 'The server confirmed the action was rejected.');
    } else if (result.state === 'COMPLETED') {
      const card = document.getElementById('card-appr-' + approvalId);
      if (card) card.remove();
      updateApprovalCount();
      addFeedItem('system-success', 'Task state: COMPLETED — ' + String(result.message || 'Review result evidence.'), result.data);
    } else {
      addFeedItem('system-pending', 'Approval processed but task is not complete: ' + String(result.state || 'UNKNOWN'));
    }
    fetchAuditLogs();
  } catch (err) {
    addFeedItem('system-failed', 'Approval state unknown; refresh server state before retrying.');
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
    if (!currentSession) return;
    const res = await fetch('/api/audit', { headers: { 'x-session-id': currentSession } });
    if (!res.ok) return;
    const data = await res.json();
    const stream = document.getElementById('audit-log-stream');
    stream.innerHTML = '';

    (data.records || []).slice(-15).reverse().forEach((r) => {
      const entry = document.createElement('div');
      entry.className = 'audit-entry';
      const timeStr = new Date(r.timestamp).toLocaleTimeString();
      const time = document.createElement('span');
      time.className = 'time';
      time.textContent = '[' + timeStr + ']';
      const event = document.createElement('span');
      event.className = 'event';
      event.textContent = String(r.eventType || 'EVENT');
      entry.append(time, document.createTextNode(' '), event, document.createTextNode(': ' + JSON.stringify(r.details || {})));
      stream.appendChild(entry);
    });
  } catch {
    // Ignore log fetch errors
  }
}
