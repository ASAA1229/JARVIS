// Browser-side Ed25519 identity and signed-request helper.
// Private CryptoKey objects are stored in IndexedDB as non-extractable keys.
// If the browser does not support Ed25519 or secure key storage, fail closed.
(() => {
  const DB_NAME = 'jarvis-device-identity';
  const STORE_NAME = 'devices';
  const CURRENT_KEY = 'current-device';
  const encoder = new TextEncoder();

  function toBase64(bytes) {
    const array = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let binary = '';
    for (let i = 0; i < array.length; i++) binary += String.fromCharCode(array[i]);
    return btoa(binary);
  }

  function toHex(bytes) {
    return Array.from(new Uint8Array(bytes), (value) => value.toString(16).padStart(2, '0')).join('');
  }

  function randomNonce() {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return toHex(bytes);
  }

  function openDatabase() {
    return new Promise((resolve, reject) => {
      if (!('indexedDB' in window) || !crypto?.subtle) {
        reject(new Error('Secure browser key storage is unavailable'));
        return;
      }
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error('Could not open secure device-key storage'));
    });
  }

  async function saveDevice(record) {
    const db = await openDatabase();
    try {
      await new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE_NAME, 'readwrite');
        transaction.objectStore(STORE_NAME).put(record);
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(new Error('Could not persist device key'));
        transaction.onabort = () => reject(new Error('Device-key storage transaction aborted'));
      });
    } finally {
      db.close();
    }
  }

  async function loadDevice() {
    const db = await openDatabase();
    try {
      return await new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE_NAME, 'readonly');
        const request = transaction.objectStore(STORE_NAME).get(CURRENT_KEY);
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => reject(new Error('Could not read device key'));
      });
    } finally {
      db.close();
    }
  }

  async function signText(privateKey, value) {
    const signature = await crypto.subtle.sign({ name: 'Ed25519' }, privateKey, encoder.encode(value));
    return toBase64(signature);
  }

  async function sha256Hex(value) {
    const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
    return toHex(digest);
  }

  function stableStringify(value) {
    if (value === null) return 'null';
    if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
    if (typeof value === 'object') {
      const record = value;
      const keys = Object.keys(record).sort();
      return '{' + keys.map((key) => JSON.stringify(key) + ':' + stableStringify(record[key])).join(',') + '}';
    }
    const encoded = JSON.stringify(value);
    return encoded === undefined ? 'null' : encoded;
  }

  async function establishSession(record) {
    const timestamp = Date.now();
    const nonce = randomNonce();
    const signature = await signText(record.privateKey, `SESSION_REQUEST:${timestamp}:${nonce}`);
    const response = await fetch('/api/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: record.deviceId, signature, timestamp, nonce }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.success !== true || !result.sessionId) {
      throw new Error(result.error || 'Secure session establishment failed');
    }
    sessionStorage.setItem('jarvis.sessionId', result.sessionId);
    sessionStorage.setItem('jarvis.deviceId', record.deviceId);
    return result.sessionId;
  }

  async function enrollDevice(challengeToken, deviceName) {
    if (!challengeToken || typeof challengeToken !== 'string') throw new Error('A valid owner-authorized enrollment challenge is required');
    const generated = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
    const publicDer = await crypto.subtle.exportKey('spki', generated.publicKey);
    const privateDer = await crypto.subtle.exportKey('pkcs8', generated.privateKey);
    const privateKey = await crypto.subtle.importKey('pkcs8', privateDer, { name: 'Ed25519' }, false, ['sign']);
    const publicBase64 = toBase64(publicDer);
    const publicLines = publicBase64.match(/.{1,64}/g).join('\n');
    const publicKey = '-----BEGIN PUBLIC KEY-----\n' + publicLines + '\n-----END PUBLIC KEY-----';

    const response = await fetch('/api/enrollment/redeem', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ challengeToken, deviceName, publicKey }),
    });
    const enrollment = await response.json().catch(() => ({}));
    if (!response.ok || enrollment.success !== true || !enrollment.deviceId) {
      throw new Error(enrollment.error || 'Device enrollment failed');
    }

    const record = { id: CURRENT_KEY, deviceId: enrollment.deviceId, deviceName, privateKey, createdAt: Date.now() };
    await saveDevice(record);
    const sessionId = await establishSession(record);
    return { deviceId: record.deviceId, deviceName: record.deviceName, sessionId };
  }

  async function restoreSession() {
    const record = await loadDevice();
    if (!record || !record.deviceId || !record.privateKey) {
      throw new Error('No enrolled device key exists in this browser');
    }
    const sessionId = await establishSession(record);
    return { deviceId: record.deviceId, deviceName: record.deviceName, sessionId };
  }

  async function signedFetch(path, options = {}) {
    const sessionId = sessionStorage.getItem('jarvis.sessionId');
    const record = await loadDevice();
    if (!sessionId || !record || !record.privateKey) {
      throw new Error('No authenticated device session; enroll this browser first');
    }

    const method = String(options.method || 'GET').toUpperCase();
    const hasBody = options.body !== undefined && options.body !== null;
    const bodyText = hasBody ? JSON.stringify(options.body) : undefined;
    const timestamp = Date.now();
    const nonce = randomNonce();
    const bodyHash = hasBody ? await sha256Hex(stableStringify(options.body)) : await sha256Hex('');
    const canonical = `${method}:${path}:${sessionId}:${timestamp}:${nonce}:${bodyHash}`;
    const signature = await signText(record.privateKey, canonical);
    const headers = new Headers(options.headers || {});
    headers.set('x-session-id', sessionId);
    headers.set('x-request-timestamp', String(timestamp));
    headers.set('x-request-nonce', nonce);
    headers.set('x-request-signature', signature);
    if (hasBody) headers.set('Content-Type', 'application/json');

    return fetch(path, {
      method,
      headers,
      body: bodyText,
      cache: 'no-store',
    });
  }

  async function currentDevice() {
    const record = await loadDevice();
    return record ? { deviceId: record.deviceId, deviceName: record.deviceName } : null;
  }

  window.JarvisDeviceCrypto = { enrollDevice, restoreSession, signedFetch, currentDevice };
})();
