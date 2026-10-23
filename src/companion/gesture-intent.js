export const GESTURE_SCHEMA_VERSION = 'jarvis.gesture-intent.v1';

const GESTURES = new Set([
  'OPEN_PALM', 'POINT_HOVER', 'PINCH', 'SWIPE_LEFT', 'SWIPE_RIGHT', 'NEUTRAL',
]);
const TARGETS = new Set([
  'hud:device-authentication', 'hud:center-stage', 'hud:governance',
  'hud:command-deck', 'hud:ptt', 'hud:mic-toggle', 'hud:camera-toggle',
]);
const INTENT_IDS = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Strict, versioned proposal contract. This module has no backend or adapter imports. */
export function validateGestureIntent(value, now = Date.now()) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort().join(',');
  if (keys !== 'capturedAt,confidence,gesture,intentId,schemaVersion,targetRef') return false;
  if (value.schemaVersion !== GESTURE_SCHEMA_VERSION || !GESTURES.has(value.gesture)) return false;
  if (typeof value.intentId !== 'string' || !INTENT_IDS.test(value.intentId)) return false;
  if (!Number.isFinite(value.confidence) || value.confidence < 0.8 || value.confidence > 1) return false;
  if (!Number.isSafeInteger(value.capturedAt) || value.capturedAt > now + 250 || now - value.capturedAt > 1000) return false;
  if (value.targetRef !== null && !TARGETS.has(value.targetRef)) return false;
  return true;
}

export function createGestureIntent({ gesture, confidence, capturedAt, targetRef }, now = Date.now()) {
  const intent = {
    schemaVersion: GESTURE_SCHEMA_VERSION,
    intentId: globalThis.crypto.randomUUID(),
    gesture,
    confidence,
    targetRef: TARGETS.has(targetRef) ? targetRef : null,
    capturedAt,
  };
  return validateGestureIntent(intent, now) ? Object.freeze(intent) : null;
}
