import { createGestureIntent } from './gesture-intent.js';
import { GestureEngine } from '../gesture/gesture-recognition.js';

const status = (text) => {
  document.getElementById('gesture-status').textContent = text;
};

let stream = null;
let worker = null;
let animationFrame = 0;
let lastFrameAt = 0;
let framePending = false;
let active = false;
let workerReady = false;
let generation = 0;
let selectedTarget = null;
let hoveredElement = null;
let trail = [];
let ctx = null;

const skeleton = [
  [0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12], [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20], [0, 17],
];

document.addEventListener('DOMContentLoaded', () => {
  const video = document.getElementById('gesture-video');
  const canvas = document.getElementById('gesture-canvas');
  ctx = canvas.getContext('2d');
  document.getElementById('btn-camera-toggle').addEventListener('click', () => {
    if (active) stopCamera('CAMERA OFF — released');
    else void startCamera();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && active) stopCamera('CAMERA OFF — tab hidden');
  });
  window.addEventListener('pagehide', () => stopCamera('CAMERA OFF — page closed'), { once: true });
  navigator.mediaDevices?.addEventListener?.('devicechange', async () => {
    if (!active || !stream) return;
    const currentId = stream.getVideoTracks()[0]?.getSettings().deviceId;
    const devices = await navigator.mediaDevices.enumerateDevices().catch(() => []);
    if (currentId && !devices.some((device) => device.kind === 'videoinput' && device.deviceId === currentId)) {
      stopCamera('CAMERA LOST — released');
    }
  });
  video.addEventListener('loadedmetadata', () => {
    canvas.width = video.videoWidth || 640;
    canvas.height = video.videoHeight || 480;
  });
  status('CAMERA OFF — gesture tracking is opt-in');
});

async function startCamera() {
  const button = document.getElementById('btn-camera-toggle');
  const video = document.getElementById('gesture-video');
  button.disabled = true;
  status('REQUESTING CAMERA PERMISSION');
  try {
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      throw new Error('Camera access requires HTTPS or trusted localhost in a supported browser.');
    }
    const myGeneration = ++generation;
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 24, max: 30 } },
    });
    if (myGeneration !== generation || document.hidden) {
      stream.getTracks().forEach((track) => track.stop());
      stream = null;
      status('CAMERA OFF — activation was interrupted');
      return;
    }
    video.srcObject = stream;
    stream.getVideoTracks().forEach((track) => {
      track.addEventListener('ended', () => {
        if (myGeneration === generation) stopCamera('CAMERA LOST — released');
      }, { once: true });
    });
    await video.play();
    worker = new Worker('/hud/gesture-worker.js', { name: 'jarvis-local-hand-tracker' });
    worker.onmessage = (event) => onWorkerMessage(event, myGeneration);
    worker.onerror = () => {
      if (myGeneration === generation) stopCamera('TRACKING ERROR — camera released');
    };
    worker.postMessage({ type: 'init' });
    active = true;
    workerReady = false;
    document.getElementById('camera-indicator').classList.add('camera-active');
    document.getElementById('camera-indicator').textContent = '● CAMERA ACTIVE — LOCAL PROCESSING';
    button.textContent = 'STOP CAMERA';
    button.setAttribute('aria-pressed', 'true');
    document.getElementById('gesture-preview').classList.add('preview-active');
    status('CAMERA ACTIVE — loading local model');
    renderLoop(myGeneration);
  } catch (error) {
    const reason = error?.name === 'NotAllowedError' || error?.name === 'SecurityError'
      ? 'CAMERA PERMISSION DENIED — camera remains off'
      : error?.name === 'NotFoundError' || error?.name === 'DevicesNotFoundError'
        ? 'NO CAMERA DEVICE FOUND — camera remains off'
        : error?.name === 'NotReadableError' || error?.name === 'TrackStartError'
          ? 'CAMERA UNAVAILABLE — another app may be using it'
          : (error instanceof Error ? error.message : 'Camera unavailable; check browser permission and device.');
    stopCamera(reason);
  } finally {
    if (generation === 0 || !active) button.disabled = false;
    else button.disabled = false;
  }
}

function renderLoop(myGeneration) {
  if (!active || generation !== myGeneration) return;
  const video = document.getElementById('gesture-video');
  const canvas = document.getElementById('gesture-canvas');
  if (workerReady && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && !framePending && performance.now() - lastFrameAt >= 100) {
    framePending = true;
    lastFrameAt = performance.now();
    createImageBitmap(video).then((bitmap) => {
      if (!active || generation !== myGeneration || !worker) {
        bitmap.close();
        return;
      }
      worker.postMessage({ type: 'frame', bitmap, capturedAt: Date.now() }, [bitmap]);
    }).catch(() => { framePending = false; });
  }
  if (canvas.width !== video.videoWidth && video.videoWidth) {
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
  }
  animationFrame = requestAnimationFrame(() => renderLoop(myGeneration));
}

function onWorkerMessage(event, myGeneration) {
  if (generation !== myGeneration || !active) return;
  const message = event.data;
  if (message.type === 'ready') {
    workerReady = true;
    status('CAMERA ACTIVE — local hand tracking ready');
    framePending = false;
    return;
  }
  if (message.type === 'error') {
    stopCamera(message.reason);
    return;
  }
  if (message.type !== 'tracking') return;
  framePending = false;
  if (!message.sample) {
    clearOverlay();
    clearTarget();
    status(message.state);
    return;
  }
  const { sample } = message;
  drawHand(sample.points || []);
  if (sample.cursor) {
    moveReticle(sample.cursor);
    hoveredElement?.classList.remove('gesture-hover-target');
    selectedTarget = resolveHudTarget(sample.cursor);
    document.getElementById('gesture-target').textContent = selectedTarget?.label || 'No supported HUD target';
  }
  if (sample.event) {
    const intent = createGestureIntent({
      gesture: sample.event.gesture,
      confidence: sample.event.confidence,
      capturedAt: sample.event.capturedAt,
      targetRef: selectedTarget?.id || null,
    });
    if (intent) renderProposal(intent);
  }
  status(`${message.state} · ${sample.pose} · heuristic ${Math.round(sample.confidence * 100)}%`);
}

function resolveHudTarget(cursor) {
  const x = Math.max(0, Math.min(innerWidth - 1, cursor.x * innerWidth));
  const y = Math.max(0, Math.min(innerHeight - 1, cursor.y * innerHeight));
  const hit = document.elementFromPoint(x, y)?.closest('[data-gesture-target]');
  if (!hit) return null;
  const id = hit.dataset.gestureTarget;
  if (!id || !document.querySelector(`[data-gesture-target="${CSS.escape(id)}"]`)) return null;
  hit.classList.add('gesture-hover-target');
  hoveredElement = hit;
  return { id: `hud:${id}`, label: hit.getAttribute('data-gesture-label') || id };
}

function moveReticle(cursor) {
  const reticle = document.getElementById('gesture-reticle');
  reticle.style.transform = `translate3d(${Math.round(cursor.x * innerWidth)}px, ${Math.round(cursor.y * innerHeight)}px, 0)`;
  reticle.classList.add('visible');
  trail.push({ x: cursor.x * innerWidth, y: cursor.y * innerHeight });
  if (trail.length > 10) trail.shift();
  const svg = document.getElementById('gesture-trail');
  svg.setAttribute('viewBox', `0 0 ${innerWidth} ${innerHeight}`);
  document.getElementById('gesture-trail-line').setAttribute('points', trail.map((point) => `${Math.round(point.x)},${Math.round(point.y)}`).join(' '));
}

function drawHand(points) {
  clearOverlay();
  if (!ctx || points.length !== 21) return;
  const canvas = document.getElementById('gesture-canvas');
  ctx.strokeStyle = 'rgba(0, 229, 255, .9)';
  ctx.fillStyle = '#dffcff';
  ctx.lineWidth = 2;
  for (const [from, to] of skeleton) {
    ctx.beginPath();
    ctx.moveTo(points[from].x * canvas.width, points[from].y * canvas.height);
    ctx.lineTo(points[to].x * canvas.width, points[to].y * canvas.height);
    ctx.stroke();
  }
  for (const point of points) {
    ctx.beginPath();
    ctx.arc(point.x * canvas.width, point.y * canvas.height, 3, 0, Math.PI * 2);
    ctx.fill();
  }
}

function clearOverlay() {
  if (ctx) ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
}

function clearTarget() {
  hoveredElement?.classList.remove('gesture-hover-target');
  hoveredElement = null;
  document.getElementById('gesture-reticle').classList.remove('visible');
  document.getElementById('gesture-trail-line').setAttribute('points', '');
  document.getElementById('gesture-target').textContent = 'None';
  selectedTarget = null;
  trail = [];
}

function renderProposal(intent) {
  const action = {
    OPEN_PALM: 'Stop/cancel preview only',
    POINT_HOVER: 'Highlight supported HUD target',
    PINCH: 'Selection preview only — confirmation is not wired',
    SWIPE_LEFT: 'Left navigation preview only — no panel action sent',
    SWIPE_RIGHT: 'Right navigation preview only — no panel action sent',
    NEUTRAL: 'Return to idle',
  }[intent.gesture];
  document.getElementById('gesture-name').textContent = intent.gesture.replaceAll('_', ' ');
  document.getElementById('gesture-confidence').textContent = `${Math.round(intent.confidence * 100)}% heuristic score`;
  document.getElementById('gesture-action').textContent = action;
  document.getElementById('gesture-proposal').classList.add('proposal-active');
  if (intent.gesture === 'OPEN_PALM') {
    document.getElementById('gesture-proposal').classList.remove('proposal-active');
    document.getElementById('gesture-name').textContent = 'CANCEL / REST';
  }
}

function stopCamera(message = 'CAMERA OFF — released') {
  generation++;
  active = false;
  workerReady = false;
  framePending = false;
  if (animationFrame) cancelAnimationFrame(animationFrame);
  animationFrame = 0;
  if (worker) {
    try { worker.postMessage({ type: 'stop' }); } catch { /* Worker may already have failed. */ }
    worker.terminate();
    worker = null;
  }
  if (stream) {
    for (const track of stream.getTracks()) track.stop();
    stream = null;
  }
  const video = document.getElementById('gesture-video');
  if (video) video.srcObject = null;
  clearOverlay();
  clearTarget();
  document.getElementById('camera-indicator').classList.remove('camera-active');
  document.getElementById('gesture-preview').classList.remove('preview-active');
  document.getElementById('camera-indicator').textContent = 'CAMERA OFF';
  const button = document.getElementById('btn-camera-toggle');
  button.textContent = 'ENABLE CAMERA';
  button.setAttribute('aria-pressed', 'false');
  button.disabled = false;
  status(message);
}
