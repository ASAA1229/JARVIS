importScripts('/gesture/gesture-recognition-core.js', '/gesture/vision_bundle.js');

let landmarker = null;
let engine = null;
let lastTimestamp = 0;

self.onmessage = async (event) => {
  const message = event.data;
  if (message?.type === 'init') {
    try {
      const fileset = await self.Vision.FilesetResolver.forVisionTasks('/gesture/wasm');
      landmarker = await self.Vision.HandLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: '/gesture/hand_landmarker.task', delegate: 'CPU' },
        runningMode: 'VIDEO',
        numHands: 2,
        minHandDetectionConfidence: 0.65,
        minHandPresenceConfidence: 0.65,
        minTrackingConfidence: 0.65,
      });
      engine = new self.JarvisGestureEngine();
      self.postMessage({ type: 'ready' });
    } catch (error) {
      const detail = error instanceof Error
        ? `${error.name}: ${error.message.slice(0, 160)}`
        : 'unknown initialization error';
      self.postMessage({ type: 'error', reason: `Local hand-tracking runtime/model unavailable (${detail}).` });
    }
    return;
  }

  if (message?.type === 'stop') {
    landmarker?.close();
    landmarker = null;
    engine?.reset();
    engine = null;
    self.close();
    return;
  }

  if (message?.type !== 'frame' || !landmarker || !engine) {
    message?.bitmap?.close?.();
    return;
  }

  const { bitmap, capturedAt } = message;
  try {
    lastTimestamp = Math.max(lastTimestamp + 1, capturedAt);
    const result = landmarker.detectForVideo(bitmap, lastTimestamp);
    if (result.landmarks.length !== 1) {
      engine.reset();
      self.postMessage({ type: 'tracking', state: result.landmarks.length > 1 ? 'MULTIPLE HANDS — PAUSED' : 'NO HAND DETECTED' });
      return;
    }
    const sample = engine.update(result.landmarks[0], capturedAt);
    self.postMessage({ type: 'tracking', state: 'LOCAL TRACKING', sample });
  } catch {
    engine.reset();
    self.postMessage({ type: 'error', reason: 'Local landmark inference failed; camera was stopped.' });
  } finally {
    bitmap.close();
  }
};
