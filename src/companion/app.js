// Browser companion UI using the real device cryptography module.
let currentDevice = null;
let currentSession = null;
let activeChallenge = null;
let pendingApprovals = new Map();
let isRequestSubmitting = false;
// Keep one conversational thread active for this companion page session.
let activeConversationId = null;

document.addEventListener('DOMContentLoaded', () => {
  setupEventListeners();
  restoreExistingDevice();
  pollStatus();
  setInterval(pollStatus, 3000);
  setInterval(fetchAuditLogs, 4000);
  setInterval(fetchNotifications, 10000);
  setInterval(fetchRecoveryTasks, 10000);
});

function setupEventListeners() {
  document.getElementById('btn-create-challenge').addEventListener('click', handleCreateChallenge);
  document.getElementById('btn-enroll-browser').addEventListener('click', handleBrowserDeviceEnrollment);
  document.getElementById('btn-revoke-device').addEventListener('click', handleRevokeDevice);
  document.getElementById('btn-send-request').addEventListener('click', handleSendRequest);
  document.getElementById('btn-refresh-audit').addEventListener('click', fetchAuditLogs);
  document.getElementById('btn-refresh-notifications').addEventListener('click', fetchNotifications);
  document.getElementById('btn-refresh-recovery').addEventListener('click', fetchRecoveryTasks);
  document.getElementById('btn-refresh-schedules').addEventListener('click', requestScheduleList);
  document.getElementById('schedule-form').addEventListener('submit', handleCreateSchedule);
  document.getElementById('btn-refresh-memories').addEventListener('click', requestMemoryList);
  document.getElementById('memory-form').addEventListener('submit', handleSaveMemory);
  document.getElementById('btn-totp-setup').addEventListener('click', handleTotpSetup);
  document.getElementById('btn-totp-verify').addEventListener('click', handleTotpVerify);
  document.getElementById('btn-totp-disable').addEventListener('click', handleTotpDisable);
  document.getElementById('btn-create-transaction').addEventListener('click', handleCreateTransaction);
  document.getElementById('btn-cancel-transaction').addEventListener('click', handleCancelTransaction);
  document.getElementById('btn-submit-enrollment').addEventListener('click', handleSubmitEnrollment);

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
  const ownerToken = window.prompt('Enter the configured owner control token to authorize enrollment:');
  if (!ownerToken) return;

  const box = document.getElementById('challenge-box');
  const qr = document.getElementById('challenge-qr');
  const status = document.getElementById('challenge-status');
  const timer = document.getElementById('challenge-timer');
  const token = document.getElementById('challenge-token');
  const uri = document.getElementById('challenge-uri');

  try {
    const res = await fetch('/api/enrollment/challenge', {
      method: 'POST',
      headers: { 'x-owner-control-token': ownerToken },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.challengeToken) {
      throw new Error(data.error || 'Enrollment challenge failed with HTTP ' + res.status);
    }
    const expiresAt = Number(data.expiresAt || Date.now() + 120000);
    activeChallenge = { ...data, expiresAt };

    const svg = typeof data.qrSvg === 'string' && data.qrSvg.trim().startsWith('<svg') ? data.qrSvg : null;
    if (svg && qr) {
      qr.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
      qr.classList.remove('hidden');
    } else if (qr) {
      qr.removeAttribute('src');
      qr.classList.add('hidden');
    }

    token.textContent = data.challengeToken;
    if (uri) {
      uri.textContent = data.uri || `jarvis://enroll?challengeToken=${encodeURIComponent(data.challengeToken)}`;
    }
    box.classList.remove('hidden');
    status.textContent = 'Scan with another device or enter the challenge token manually. Approval is still required from an already-authorized owner device.';

    const updateCountdown = () => {
      const remaining = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
      timer.textContent = `Expires in: ${remaining}s`;
      if (!remaining) {
        status.textContent = 'Challenge expired. Generate a new challenge to continue.';
        box.classList.add('expired');
      }
    };
    updateCountdown();
    if (activeChallenge.countdownTimer) clearInterval(activeChallenge.countdownTimer);
    activeChallenge.countdownTimer = setInterval(updateCountdown, 1000);
  } catch (err) {
    activeChallenge = null;
    if (status) {
      status.textContent = err instanceof Error ? err.message : 'Unknown enrollment error';
    }
    box.classList.remove('hidden');
    if (qr) qr.classList.add('hidden');
    alert('Failed to generate challenge: ' + (err instanceof Error ? err.message : 'Unknown error'));
  }
}

async function handleBrowserDeviceEnrollment() {
  try {
    if (!activeChallenge) await handleCreateChallenge();
    if (!activeChallenge || !activeChallenge.challengeToken) {
      throw new Error('Create an owner-authorized enrollment challenge first.');
    }
    const enrolled = await window.JarvisDeviceCrypto.enrollDevice(
      activeChallenge.challengeToken,
      'JARVIS Browser Companion',
    );
    currentDevice = { id: enrolled.deviceId, name: enrolled.deviceName, permissions: enrolled.permissions };
    currentSession = enrolled.sessionId;
    activeChallenge = null;
    document.getElementById('challenge-box').classList.add('hidden');
    updateUIWithDevice();
    addFeedItem('system-success', 'This browser is enrolled with a non-extractable private key and a signed session.');
  } catch (err) {
    currentDevice = null;
    currentSession = null;
    setEnrollmentUnavailable(err instanceof Error ? err.message : 'Secure enrollment failed.');
  }
}

async function restoreExistingDevice() {
  try {
    const existing = await window.JarvisDeviceCrypto.currentDevice();
    if (!existing) return;
    const session = await window.JarvisDeviceCrypto.restoreSession();
    currentDevice = { id: session.deviceId, name: session.deviceName, permissions: session.permissions };
    currentSession = session.sessionId;
    updateUIWithDevice();
  } catch (err) {
    currentDevice = null;
    currentSession = null;
    setEnrollmentUnavailable(err instanceof Error ? err.message : 'Could not restore the device session.');
  }
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
  const canManage = Boolean(currentDevice?.permissions?.includes('device:manage:execute'));
  document.getElementById('owner-security').classList.toggle('hidden', !canManage);
  if (canManage) refreshSecurityPanels();
  void fetchNotifications();
  // Schedule listing is user-triggered to avoid competing with a newly submitted request.
}

function qrData(svg) { return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg); }

async function signedJson(path, method = 'GET', body) {
  const response = await window.JarvisDeviceCrypto.signedFetch(path, { method, body });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(value.error || `Request failed (${response.status})`);
  return value;
}

async function refreshSecurityPanels() {
  try {
    const [deviceResult, pendingResult, totp] = await Promise.all([
      signedJson('/api/devices'), signedJson('/api/enrollment/pending'), signedJson('/api/security/totp/status'),
    ]);
    const status = document.getElementById('totp-status');
    status.textContent = 'Authenticator: ' + totp.status;
    status.classList.toggle('success', totp.status === 'ENABLED');
    document.getElementById('btn-totp-setup').classList.toggle('hidden', totp.status === 'ENABLED');
    document.getElementById('btn-totp-disable').classList.toggle('hidden', totp.status !== 'ENABLED');
    renderDevices(deviceResult.devices || []);
    renderPendingEnrollments(pendingResult.requests || []);
  } catch (error) {
    document.getElementById('pending-enrollments').textContent = error.message;
    document.getElementById('authorized-devices').textContent = error.message;
  }
}

function renderDevices(devices) {
  const container = document.getElementById('authorized-devices');
  container.replaceChildren();
  if (!devices.length) { container.textContent = 'No devices enrolled.'; return; }
  for (const device of devices) {
    const row = document.createElement('div'); row.className = 'security-record';
    const details = document.createElement('div');
    const title = document.createElement('strong'); title.textContent = device.name + ' · ' + (device.platform || 'Unknown platform');
    const meta = document.createElement('small'); meta.textContent = `${device.status} · enrolled ${new Date(device.enrolledAt).toLocaleString()} · last activity ${new Date(device.lastActivityAt).toLocaleString()} · session ${device.sessionActive ? 'active' : 'inactive'}`;
    details.append(title, meta); row.append(details);
    if (device.status === 'ACTIVE') {
      const revoke = document.createElement('button'); revoke.className = 'btn btn-danger'; revoke.textContent = 'Revoke';
      revoke.addEventListener('click', () => revokeManagedDevice(device)); row.append(revoke);
    }
    container.append(row);
  }
}

function renderPendingEnrollments(requests) {
  const container = document.getElementById('pending-enrollments'); container.replaceChildren();
  if (!requests.length) { container.textContent = 'No pending requests.'; return; }
  for (const request of requests) {
    const row = document.createElement('div'); row.className = 'security-record';
    const details = document.createElement('div'); const title = document.createElement('strong');
    title.textContent = request.deviceName + ' · ' + request.platform;
    const meta = document.createElement('small'); meta.textContent = `Requested ${new Date(request.requestedAt).toLocaleString()} · permissions: ${request.permissions.join(', ')}`;
    details.append(title, meta); row.append(details);
    const approve = document.createElement('button'); approve.className = 'btn btn-primary'; approve.textContent = 'Approve';
    approve.addEventListener('click', async () => {
      const totpCode = document.getElementById('enrollment-totp-code').value.trim();
      if (!totpCode) { alert('Enter a fresh authenticator code first.'); return; }
      try { await signedJson('/api/enrollment/approve', 'POST', { transactionId: request.transactionId, requestHash: request.requestHash, totpCode }); document.getElementById('enrollment-totp-code').value = ''; await refreshSecurityPanels(); }
      catch (error) { alert('Approval failed: ' + error.message); }
    });
    const reject = document.createElement('button'); reject.className = 'btn btn-danger'; reject.textContent = 'Reject';
    reject.addEventListener('click', async () => { try { await signedJson('/api/enrollment/reject', 'POST', { transactionId: request.transactionId }); await refreshSecurityPanels(); } catch (error) { alert('Rejection failed: ' + error.message); } });
    row.append(approve, reject); container.append(row);
  }
}

async function handleTotpSetup() {
  try {
    const result = await signedJson('/api/security/totp/setup', 'POST', {});
    document.getElementById('totp-qr').src = qrData(result.qrSvg);
    document.getElementById('totp-secret').textContent = result.secret;
    document.getElementById('totp-setup-panel').classList.remove('hidden');
  } catch (error) { alert('Authenticator setup failed: ' + error.message); }
}

async function handleTotpVerify() {
  const code = document.getElementById('totp-setup-code').value.trim();
  try {
    await signedJson('/api/security/totp/verify-setup', 'POST', { code });
    document.getElementById('totp-setup-panel').classList.add('hidden');
    document.getElementById('totp-secret').textContent = '';
    document.getElementById('totp-setup-code').value = '';
    await refreshSecurityPanels();
  } catch (error) { alert('Authenticator verification failed: ' + error.message); }
}

async function handleTotpDisable() {
  const code = window.prompt('Enter a fresh authenticator code to disable two-factor verification:');
  if (!code) return;
  try { await signedJson('/api/security/totp/disable', 'POST', { code }); await refreshSecurityPanels(); }
  catch (error) { alert('Could not disable authenticator: ' + error.message); }
}

async function handleCreateTransaction() {
  const totpCode = document.getElementById('enrollment-totp-code').value.trim();
  const permissions = ['system:info:read'];
  if (document.getElementById('permission-app-launch').checked) permissions.push('app:launch:execute');
  if (document.getElementById('permission-device-manage').checked) permissions.push('device:manage:execute');
  try {
    const result = await signedJson('/api/enrollment/transactions', 'POST', { totpCode, permissions });
    activeChallenge = result;
    document.getElementById('enrollment-qr').src = qrData(result.qrSvg);
    document.getElementById('enrollment-code').textContent = result.code;
    document.getElementById('transaction-panel').classList.remove('hidden');
    document.getElementById('enrollment-totp-code').value = '';
    const update = () => {
      const remaining = Math.max(0, Math.ceil((result.expiresAt - Date.now()) / 1000));
      document.getElementById('transaction-countdown').textContent = `${remaining}s`;
      if (!remaining) { document.getElementById('transaction-panel').classList.add('hidden'); activeChallenge = null; }
    };
    update(); activeChallenge.timer = setInterval(update, 1000);
    await refreshSecurityPanels();
  } catch (error) { alert('Could not start enrollment: ' + error.message); }
}

async function handleCancelTransaction() {
  if (!activeChallenge?.transactionId) return;
  try {
    await signedJson('/api/enrollment/cancel', 'POST', { transactionId: activeChallenge.transactionId });
    clearInterval(activeChallenge.timer); activeChallenge = null;
    document.getElementById('transaction-panel').classList.add('hidden');
  } catch (error) { alert('Cancellation failed: ' + error.message); }
}

async function handleSubmitEnrollment() {
  const status = document.getElementById('enrollment-request-status');
  let transactionId = document.getElementById('enrollment-transaction-id').value.trim();
  let code = document.getElementById('enrollment-entry-code').value.trim();
  if (transactionId.startsWith('jarvis://')) {
    try { const parsed = new URL(transactionId); transactionId = parsed.searchParams.get('transaction') || ''; code = parsed.searchParams.get('code') || code; }
    catch { status.textContent = 'The scanned enrollment link is invalid.'; return; }
  }
  status.textContent = 'Sending signed device request; awaiting owner approval…';
  try {
    const enrolled = await window.JarvisDeviceCrypto.requestEnrollment(transactionId, code, 'JARVIS Browser Companion', 'Browser');
    currentDevice = { id: enrolled.deviceId, name: enrolled.deviceName, permissions: enrolled.permissions };
    currentSession = enrolled.sessionId; status.textContent = 'Enrolled after owner approval.'; updateUIWithDevice();
  } catch (error) { status.textContent = error instanceof Error ? error.message : 'Enrollment did not complete.'; }
}

async function revokeManagedDevice(device) {
  if (!confirm(`Immediately revoke ${device.name} and invalidate its sessions?`)) return;
  const totpCode = window.prompt('Enter a fresh authenticator code to confirm revocation:');
  if (!totpCode) return;
  try { await signedJson('/api/device/revoke', 'POST', { deviceId: device.id, reason: 'Owner initiated', totpCode }); await refreshSecurityPanels(); }
  catch (error) { alert('Revocation failed: ' + error.message); }
}

async function handleRevokeDevice() {
  if (!currentDevice) return;
  if (!confirm(`Are you sure you want to revoke ${currentDevice.name}? Immediate revocation is enforced.`)) return;

  try {
    const totpCode = document.getElementById('totp-status').textContent.includes('ENABLED') ? window.prompt('Enter a fresh authenticator code to confirm revocation:') : undefined;
    if (document.getElementById('totp-status').textContent.includes('ENABLED') && !totpCode) return;
    const revokeResponse = await window.JarvisDeviceCrypto.signedFetch('/api/device/revoke', {
      method: 'POST',
      body: { deviceId: currentDevice.id, reason: 'Manual self-revocation', ...(totpCode ? { totpCode } : {}) },
    });
    const revokeResult = await revokeResponse.json().catch(() => ({}));
    if (!revokeResponse.ok || revokeResult.success !== true) {
      throw new Error(revokeResult.error || 'Device revocation was not confirmed');
    }

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
  const sendButton = document.getElementById('btn-send-request');
  const text = input.value.trim();
  if (!text) return;
  if (isRequestSubmitting) return;

  if (!currentSession) {
    addFeedItem('system-failed', 'Request not sent: secure device enrollment is not configured.');
    return;
  }

  isRequestSubmitting = true;
  sendButton.disabled = true;
  const originalButtonText = sendButton.textContent;
  sendButton.textContent = 'Sending…';
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000);
  addFeedItem('user', text);
  setPipeline({ sent: 'active' }, 'Request sent; waiting for the policy gateway.');

  try {
    const res = await window.JarvisDeviceCrypto.signedFetch('/api/request', {
      method: 'POST',
      body: { text, ...(activeConversationId ? { conversationId: activeConversationId } : {}) },
      signal: controller.signal,
    });

    const data = await readApiResponse(res);
    if (typeof data.data?.conversationId === 'string') {
      activeConversationId = data.data.conversationId;
    }
    if (/^list (?:my )?schedules$/i.test(text) && data.state === 'COMPLETED' && data.outcome === 'VERIFIED_SUCCESS') {
      renderSchedules(Array.isArray(data.data) ? data.data : []);
    }
    if (/^(?:list|show) my memories$|^what do you remember\??$/i.test(text) && data.state === 'COMPLETED' && data.outcome === 'VERIFIED_SUCCESS') {
      renderMemories(Array.isArray(data.data) ? data.data : []);
    }
    if (/^remember (?:preference|project|routine|general):/i.test(text) ||
        /^update memory [a-f0-9]{32} to /i.test(text) ||
        /^forget memory [a-f0-9]{32}$/i.test(text)) {
      const memoryStatus = document.getElementById('memories-status');
      if (memoryStatus) memoryStatus.textContent = 'Memory request submitted. Refresh after approval/completion to verify the saved state.';
    }
    input.value = '';

    if (data.approvalId && data.state === 'AWAITING_APPROVAL') {
      addApprovalCard(data.approvalId, data.taskId, text, data.message);
      addFeedItem('system-pending', `Requires approval: ${data.message}`, data);
      setPipeline({ sent: 'done', policy: 'done', approval: 'warn' }, 'Waiting for your explicit approval. It is single-use and bound to this exact action.');
    } else if (data.state === 'COMPLETED' &&
        data.outcome === 'VERIFIED_SUCCESS' && data.verified === true) {
      addFeedItem('system-success', `Outcome verified: ${data.message}`, data.data);
      setPipeline({ sent: 'done', policy: 'done', approval: 'skip', verify: 'done' }, 'Allowed by policy without approval and verified by the host.');
    } else if (data.state === 'PARTIAL' || data.state === 'AWAITING_RECOVERY' ||
        data.outcome === 'UNCERTAIN' || data.verified === false) {
      addFeedItem('system-pending', `Outcome not fully verified: ${data.message}`, data.data);
      setPipeline({ sent: 'done', policy: 'done', approval: 'skip', verify: 'warn' }, 'The outcome could not be confirmed. Check the laptop before retrying.');
    } else {
      addFeedItem('system-failed', `Request denied or failed: ${data.message || data.error}`, data);
      setPipeline({ sent: 'done', policy: 'bad' }, 'Denied or failed at the policy gateway. Nothing was executed.');
    }

    fetchAuditLogs();
  } catch (err) {
    const message = controller.signal.aborted
      ? 'Request timed out; the server may have received it. Check task state before retrying.'
      : (err instanceof Error ? err.message : 'Request failed');
    addFeedItem('system-failed', message);
    setPipeline({ sent: 'bad' }, 'The request did not complete. Its server-side state is unknown.');
  } finally {
    clearTimeout(timeoutId);
    isRequestSubmitting = false;
    sendButton.disabled = false;
    sendButton.textContent = originalButtonText;
  }
}

async function handleSaveMemory(event) {
  event.preventDefault();
  const content = document.getElementById('memory-content').value.trim();
  const category = document.getElementById('memory-category').value;
  const status = document.getElementById('memories-status');
  if (!content) {
    status.textContent = 'Enter the memory text first.';
    return;
  }
  document.getElementById('input-request').value = 'remember ' + category + ': ' + content;
  status.textContent = 'Submitting memory save through JARVIS policy and approval checks.';
  await handleSendRequest();
}

async function requestMemoryList() {
  const status = document.getElementById('memories-status');
  if (!currentSession) {
    if (status) status.textContent = 'Authenticate this device to review memories.';
    return;
  }
  document.getElementById('input-request').value = 'list my memories';
  await handleSendRequest();
}

function renderMemories(records) {
  const feed = document.getElementById('memories-feed');
  const status = document.getElementById('memories-status');
  if (!feed || !status) return;
  feed.replaceChildren();
  const memories = Array.isArray(records) ? records : [];
  if (!memories.length) {
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.textContent = 'No saved memories were returned for this device.';
    feed.appendChild(empty);
    status.textContent = 'Memory list verified. No saved entries were found.';
    return;
  }
  for (const memory of memories) {
    if (!memory || typeof memory.id !== 'string' || !/^[a-f0-9]{32}$/i.test(memory.id)) continue;
    const card = document.createElement('article');
    card.className = 'task-item';
    const header = document.createElement('div');
    header.className = 'task-header';
    const category = document.createElement('strong');
    category.textContent = String(memory.category || 'general').toUpperCase();
    const updated = document.createElement('span');
    updated.textContent = Number.isFinite(Number(memory.updatedAt)) ? new Date(Number(memory.updatedAt)).toLocaleString() : 'Date unavailable';
    header.append(category, updated);
    const content = document.createElement('p');
    content.textContent = String(memory.content || '');
    const id = document.createElement('code');
    id.className = 'muted memory-id';
    id.textContent = memory.id;
    const actions = document.createElement('div');
    actions.className = 'action-row';
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'btn btn-secondary';
    edit.textContent = 'Correct';
    edit.addEventListener('click', () => {
      const editor = document.createElement('textarea');
      editor.rows = 3;
      editor.maxLength = 4000;
      editor.value = String(memory.content || '');
      editor.setAttribute('aria-label', 'Correct memory content');
      const save = document.createElement('button');
      save.type = 'button';
      save.className = 'btn btn-primary';
      save.textContent = 'Submit correction';
      save.addEventListener('click', async () => {
        if (!editor.value.trim()) {
          status.textContent = 'Memory text cannot be empty.';
          return;
        }
        document.getElementById('input-request').value = 'update memory ' + memory.id + ' to ' + editor.value.trim();
        status.textContent = 'Submitting correction through JARVIS policy and approval checks.';
        await handleSendRequest();
      });
      card.append(editor, save);
      edit.disabled = true;
    });
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'btn btn-danger';
    remove.textContent = 'Request deletion';
    remove.addEventListener('click', async () => {
      status.textContent = 'Submitting deletion through JARVIS policy and approval checks.';
      document.getElementById('input-request').value = 'forget memory ' + memory.id;
      await handleSendRequest();
    });
    actions.append(edit, remove);
    card.append(header, content, id, actions);
    feed.appendChild(card);
  }
  status.textContent = 'Showing ' + feed.children.length + ' saved memory item(s). Review or request changes below; mutations may require approval.';
}

async function handleCreateSchedule(event) {
  event.preventDefault();
  const request = document.getElementById('schedule-request').value.trim();
  const delayValue = Number(document.getElementById('schedule-delay').value);
  const delayUnit = document.getElementById('schedule-delay-unit').value;
  const repeatRaw = document.getElementById('schedule-repeat').value.trim();
  const repeatUnit = document.getElementById('schedule-repeat-unit').value;
  const status = document.getElementById('schedules-status');
  if (!request || !Number.isInteger(delayValue) || delayValue < 1) {
    status.textContent = 'Enter a request and a positive whole-number delay.';
    return;
  }
  let phrase;
  if (repeatRaw) {
    const repeatValue = Number(repeatRaw);
    if (!Number.isInteger(repeatValue) || repeatValue < 1) {
      status.textContent = 'Repeat interval must be a positive whole number.';
      return;
    }
    const repeatMinutes = repeatValue * (repeatUnit === 'hours' ? 60 : 1);
    if (repeatMinutes < 5 || repeatMinutes > 10080) {
      status.textContent = 'Repeat interval must be between 5 minutes and 7 days.';
      return;
    }
    phrase = 'schedule in ' + delayValue + ' ' + delayUnit + ' then every ' + repeatValue + ' ' + repeatUnit + ' to ' + request;
  } else {
    phrase = 'schedule in ' + delayValue + ' ' + delayUnit + ' to ' + request;
  }
  if (repeatRaw) {
    // The heuristic planner defines a recurring schedule by its repeat interval;
    // the initial delay field is not represented in that grammar.
    status.textContent = 'Submitting recurring schedule through JARVIS policy and approval checks.';
  } else {
    status.textContent = 'Submitting one-time schedule through JARVIS policy and approval checks.';
  }
  const input = document.getElementById('input-request');
  input.value = phrase;
  await handleSendRequest();
  if (!isRequestSubmitting) status.textContent = 'Request submitted. Refresh schedules after approval or completion to verify the stored job.';
}

async function requestScheduleList() {
  const status = document.getElementById('schedules-status');
  if (!currentSession) {
    if (status) status.textContent = 'Authenticate this device to view its schedules.';
    return;
  }
  const input = document.getElementById('input-request');
  input.value = 'list my schedules';
  await handleSendRequest();
}

function renderSchedules(jobs) {
  const feed = document.getElementById('schedules-feed');
  const status = document.getElementById('schedules-status');
  if (!feed || !status) return;
  feed.replaceChildren();
  const ownedJobs = Array.isArray(jobs) ? jobs : [];
  if (!ownedJobs.length) {
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.textContent = 'No schedules belong to this device.';
    feed.appendChild(empty);
    status.textContent = 'Schedule list verified; no jobs found for this device.';
    return;
  }
  for (const job of ownedJobs) {
    const row = document.createElement('div');
    row.className = 'task-item ' + (job.active ? 'pending' : 'success');
    const header = document.createElement('div');
    header.className = 'task-header';
    const id = document.createElement('strong');
    id.textContent = String(job.id || 'Unknown schedule');
    const state = document.createElement('span');
    state.textContent = job.active ? 'ACTIVE' : String(job.lastState || 'INACTIVE');
    header.append(id, state);
    const request = document.createElement('div');
    request.textContent = String(job.requestText || '');
    const meta = document.createElement('p');
    meta.className = 'muted';
    meta.textContent = 'Next run: ' + (Number.isFinite(Number(job.runAt)) ? new Date(Number(job.runAt)).toLocaleString() : 'unknown')
      + (job.everyMinutes ? ' · repeats every ' + job.everyMinutes + ' min' : ' · one-time')
      + ' · runs: ' + Number(job.runCount || 0)
      + (job.lastState ? ' · last result: ' + String(job.lastState) : '');
    row.append(header, request, meta);
    if (job.active && typeof job.id === 'string' && /^job-[a-f0-9]+$/i.test(job.id)) {
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'btn btn-danger';
      cancel.textContent = 'Cancel schedule';
      cancel.addEventListener('click', async () => {
        const input = document.getElementById('input-request');
        input.value = 'cancel schedule ' + job.id;
        status.textContent = 'Submitting cancellation through JARVIS policy and approval checks.';
        await handleSendRequest();
        status.textContent = 'Cancellation request submitted. Refresh to verify the current schedule state.';
      });
      row.appendChild(cancel);
    }
    feed.appendChild(row);
  }
  status.textContent = 'Showing ' + ownedJobs.length + ' schedule(s) owned by this device. Sensitive actions still require fresh approval at run time.';
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

  card.append(request, description);
  const risk = document.createElement('div');
  risk.className = 'approval-risk';
  risk.textContent = 'This approval is single-use, expires after a short time, and is bound to this exact action. Approving lets the laptop run it once; any change to the action needs a new approval.';
  card.append(risk, actions);
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
    const res = await window.JarvisDeviceCrypto.signedFetch(endpoint, {
      method: 'POST',
      body: { approvalId },
    });
    const result = await res.json().catch(() => ({}));
    if (!res.ok && !(res.status === 409 && typeof result.state === 'string')) {
      throw new Error(result.error || result.message || 'Approval request failed with HTTP ' + res.status);
    }
    if (!approved && result.success !== true) {
      throw new Error(result.error || result.message || 'Rejection was not confirmed by the server');
    }

    if (!approved) {
      const card = document.getElementById('card-appr-' + approvalId);
      if (card) card.remove();
      updateApprovalCount();
      addFeedItem('system-failed', 'The server confirmed the action was rejected.');
      setPipeline({ sent: 'done', policy: 'done', approval: 'bad' }, 'You rejected the action. Nothing was executed.');
    } else if (result.state === 'COMPLETED' && result.success === true &&
        result.outcome === 'VERIFIED_SUCCESS' && result.verified === true) {
      const card = document.getElementById('card-appr-' + approvalId);
      if (card) card.remove();
      updateApprovalCount();
      addFeedItem('system-success', 'Task state: COMPLETED — ' + String(result.message || 'Review result evidence.'), result.data);
      setPipeline({ sent: 'done', policy: 'done', approval: 'done', verify: 'done' }, 'Approved, executed, and verified by the host.');
    } else if (['FAILED', 'REJECTED', 'EXPIRED', 'CANCELLED', 'PARTIAL', 'AWAITING_RECOVERY'].includes(result.state)) {
      const card = document.getElementById('card-appr-' + approvalId);
      if (card) card.remove();
      updateApprovalCount();
      addFeedItem('system-failed', 'Approval was processed but the task did not complete: ' + String(result.message || result.state), result.data);
      setPipeline({ sent: 'done', policy: 'done', approval: 'done', verify: 'bad' }, 'Approved, but the task did not complete: ' + String(result.state));
    } else {
      addFeedItem('system-pending', 'Approval processed; task state remains ' + String(result.state || 'UNKNOWN') + '. Verify before retrying.');
      setPipeline({ sent: 'done', policy: 'done', approval: 'done', verify: 'warn' }, 'Approval processed, but completion is not verified.');
    }
    fetchAuditLogs();
  } catch (err) {
    addFeedItem('system-failed', 'Approval state unknown; refresh server state before retrying.');
    setPipeline({ sent: 'done', policy: 'done', approval: 'warn' }, 'Approval state is unknown. Verify before retrying.');
  }
}

function updateApprovalCount() {
  const count = document.querySelectorAll('.approval-card').length;
  document.getElementById('approval-count').innerText = `${count} Pending`;
  if (count === 0) {
    document.getElementById('no-approvals-msg').classList.remove('hidden');
  }
}

let linkFailures = 0;

function setLinkState(state, label, banner) {
  document.body.dataset.link = state;
  const dot = document.getElementById('status-dot');
  if (dot) dot.className = 'pulse-indicator ' + state;
  const text = document.getElementById('link-label');
  if (text) text.textContent = label;
  const bannerElement = document.getElementById('link-banner');
  if (bannerElement) bannerElement.textContent = banner || '';
}

const PIPELINE_STAGES = ['sent', 'policy', 'approval', 'verify'];

// Stage states: idle | active | done | warn | bad | skip. Set only from real
// server responses or real request failures.
function setPipeline(states, note) {
  for (const stage of PIPELINE_STAGES) {
    const item = document.querySelector('#task-pipeline [data-stage="' + stage + '"]');
    if (item) item.dataset.state = states[stage] || 'idle';
  }
  const noteElement = document.getElementById('pipeline-note');
  if (noteElement && note) noteElement.textContent = note;
}

async function pollStatus() {
  if (document.hidden) return;
  try {
    const res = await fetch('/api/status');
    const data = await res.json().catch(() => ({}));
    if (!res.ok || (data.status !== 'ONLINE' && data.status !== 'DEGRADED')) throw new Error('Unexpected status response');
    linkFailures = 0;
    const hostName = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' }[data.platform] || 'Unknown';
    const foot = document.getElementById('foot-host');
    if (foot) foot.textContent = hostName;
    const chain = document.getElementById('info-audit-integrity');
    if (chain && data.checks) {
      const valid = data.checks.auditIntegrity === true;
      chain.textContent = valid ? 'VALID' : 'BROKEN';
      chain.classList.toggle('success', valid);
      chain.classList.toggle('danger', !valid);
    }
    if (data.status === 'ONLINE') {
      setLinkState('online', 'LAPTOP ONLINE', '');
    } else {
      setLinkState('degraded', 'LAPTOP DEGRADED', 'The laptop core reports a failed security health check. State-changing requests may be refused until it recovers.');
    }
  } catch {
    linkFailures += 1;
    if (linkFailures < 3) {
      setLinkState('connecting', 'RECONNECTING…', 'Lost contact with the JARVIS laptop core. Retrying…');
    } else {
      setLinkState('offline', 'LAPTOP UNREACHABLE', 'The laptop may be asleep, off, or off the network. Requests cannot be delivered right now, and nothing is queued for later execution.');
    }
  }
}

async function fetchRecoveryTasks() {
  const feed = document.getElementById('recovery-feed');
  const status = document.getElementById('recovery-status');
  if (!feed || !status || document.hidden) return;
  if (!currentSession) {
    status.textContent = 'Authenticate this device to review recovery tasks.';
    return;
  }
  try {
    const result = await signedJson('/api/tasks');
    const tasks = (Array.isArray(result.tasks) ? result.tasks : [])
      .filter((task) => task && ['AWAITING_RECOVERY', 'INTERRUPTED'].includes(task.state))
      .slice(-30)
      .reverse();
    feed.replaceChildren();
    if (!tasks.length) {
      const empty = document.createElement('p');
      empty.className = 'muted';
      empty.textContent = 'No tasks currently require manual recovery review.';
      feed.appendChild(empty);
      status.textContent = 'Recovery list checked; no uncertain tasks were returned for this device.';
      return;
    }
    for (const task of tasks) {
      const card = document.createElement('article');
      card.className = 'task-item pending';
      const header = document.createElement('div');
      header.className = 'task-header';
      const title = document.createElement('strong');
      title.textContent = String(task.id || 'Unknown task');
      const state = document.createElement('span');
      state.textContent = String(task.state);
      header.append(title, state);
      const operation = document.createElement('p');
      operation.textContent = 'Operation: ' + String(task.operation || 'multi-step workflow');
      const warning = document.createElement('p');
      warning.className = 'muted';
      warning.textContent = 'Inspect the target app/device first. Choosing a disposition records your review only; it does not retry the operation.';
      const actions = document.createElement('div');
      actions.className = 'action-row';
      const choices = [
        ['confirmed_no_effect', 'Confirm no effect'],
        ['effect_observed', 'Effect observed'],
        ['still_unknown', 'Still unknown'],
      ];
      for (const [disposition, label] of choices) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = disposition === 'still_unknown' ? 'btn btn-secondary' : 'btn btn-primary';
        button.textContent = label;
        button.addEventListener('click', async () => {
          const note = window.prompt('Describe what you checked (8–500 characters). Do not include passwords or secrets:');
          if (note === null) return;
          if (note.trim().length < 8 || note.length > 500) {
            status.textContent = 'Recovery note must be 8–500 characters.';
            return;
          }
          for (const action of actions.querySelectorAll('button')) action.disabled = true;
          try {
            const reviewed = await signedJson('/api/task/reconcile', 'POST', {
              taskId: String(task.id),
              disposition,
              note: note.trim(),
            });
            status.textContent = reviewed.message || 'Recovery review recorded; no operation was replayed.';
            await fetchRecoveryTasks();
            await fetchNotifications();
          } catch (error) {
            status.textContent = error instanceof Error ? 'Recovery review failed: ' + error.message : 'Recovery review failed.';
            for (const action of actions.querySelectorAll('button')) action.disabled = false;
          }
        });
        actions.appendChild(button);
      }
      card.append(header, operation, warning, actions);
      feed.appendChild(card);
    }
    status.textContent = 'Showing ' + tasks.length + ' task(s) requiring manual recovery review.';
  } catch (error) {
    status.textContent = error instanceof Error
      ? 'Recovery tasks unavailable: ' + error.message
      : 'Recovery tasks unavailable. Check the authenticated connection.';
  }
}

async function fetchNotifications() {
  const feed = document.getElementById('notifications-feed');
  const status = document.getElementById('notifications-status');
  if (!feed || !status) return;
  if (document.hidden) return;
  if (!currentSession) {
    status.textContent = 'Authenticate this device to view its notifications.';
    return;
  }
  try {
    const result = await signedJson('/api/notifications');
    const notifications = Array.isArray(result.notifications) ? result.notifications.slice(-30).reverse() : [];
    feed.replaceChildren();
    if (!notifications.length) {
      const empty = document.createElement('p');
      empty.className = 'muted';
      empty.textContent = 'No recent notifications.';
      feed.appendChild(empty);
    } else {
      for (const notification of notifications) {
        const entry = document.createElement('div');
        entry.className = 'task-item ' + (notification.level === 'error' ? 'failed' : notification.level === 'warning' ? 'pending' : 'success');
        const header = document.createElement('div');
        header.className = 'task-header';
        const time = document.createElement('span');
        time.textContent = new Date(Number(notification.at)).toLocaleString();
        const kind = document.createElement('strong');
        kind.textContent = String(notification.kind || 'notification').replaceAll('_', ' ').toUpperCase();
        header.append(time, kind);
        const message = document.createElement('div');
        message.textContent = String(notification.message || 'No details provided.');
        entry.append(header, message);
        feed.appendChild(entry);
      }
    }
    status.textContent = 'Showing ' + notifications.length + ' recent notification(s) for this device.';
  } catch (error) {
    status.textContent = error instanceof Error
      ? 'Notifications unavailable: ' + error.message
      : 'Notifications unavailable. Check the authenticated connection.';
  }
}

async function fetchAuditLogs() {
  try {
    if (!currentSession) return;
    const stream = document.getElementById('audit-log-stream');
    if (!currentDevice?.permissions?.includes('device:manage:execute')) {
      stream.replaceChildren();
      const notice = document.createElement('div');
      notice.className = 'audit-entry';
      notice.textContent = 'Audit access requires DEVICE_MANAGE permission.';
      stream.appendChild(notice);
      return;
    }
    const res = await window.JarvisDeviceCrypto.signedFetch('/api/audit');
    if (!res.ok) return;
    const data = await res.json();
    stream.replaceChildren();

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
