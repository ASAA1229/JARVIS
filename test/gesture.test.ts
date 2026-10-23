import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createGestureIntent, GESTURE_SCHEMA_VERSION, validateGestureIntent } from '../src/companion/gesture-intent.js';
import { GestureEngine } from '../src/companion/gesture-recognition.js';

function intent(overrides: Record<string, unknown> = {}, now = Date.now()) {
  return {
    schemaVersion: GESTURE_SCHEMA_VERSION,
    intentId: 'd9428888-122b-4a67-8b2f-2424852448e7',
    gesture: 'POINT_HOVER',
    confidence: 0.86,
    targetRef: 'hud:command-deck',
    capturedAt: now,
    ...overrides,
  };
}

function landmarks({ open = true, point = false, pinch = false } = {}) {
  const points = Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.65, z: 0 }));
  points[0] = { x: 0.5, y: 0.88, z: 0 };
  points[5] = { x: 0.34, y: 0.57, z: 0 };
  points[17] = { x: 0.66, y: 0.58, z: 0 };
  for (const [tip, pip] of [[8, 6], [12, 10], [16, 14], [20, 18]]) {
    points[pip] = { x: 0.4 + tip / 100, y: 0.43, z: 0 };
    points[tip] = { x: 0.4 + tip / 100, y: open ? 0.2 : 0.62, z: 0 };
  }
  if (point) {
    points[8].y = 0.2;
    points[12].y = 0.72;
    points[16].y = 0.72;
    points[20].y = 0.72;
  }
  points[4] = { x: 0.24, y: 0.6, z: 0 };
  if (pinch) points[4] = { x: points[8].x + 0.005, y: points[8].y + 0.005, z: 0 };
  return points;
}

test('GESTURE-01: versioned contract accepts only fresh, bounded, allowlisted intents', () => {
  const now = Date.now();
  assert.equal(validateGestureIntent(intent({}, now), now), true);
  assert.equal(validateGestureIntent(intent({ schemaVersion: 'v2' }, now), now), false);
  assert.equal(validateGestureIntent(intent({ gesture: 'RUN_COMMAND' }, now), now), false);
  assert.equal(validateGestureIntent(intent({ targetRef: 'hud:anything' }, now), now), false);
  assert.equal(validateGestureIntent(intent({ confidence: 0.79 }, now), now), false);
  assert.equal(validateGestureIntent(intent({ confidence: 1.01 }, now), now), false);
  assert.equal(validateGestureIntent(intent({ capturedAt: now - 1001 }, now), now), false);
  assert.equal(validateGestureIntent(intent({ capturedAt: now + 251 }, now), now), false);
  assert.equal(validateGestureIntent({ ...intent({}, now), command: 'delete files' }, now), false);
  assert.equal(validateGestureIntent(null, now), false);
});

test('GESTURE-02: intent factory drops unsupported target references and rejects low scores', () => {
  const now = Date.now();
  const safe = createGestureIntent({ gesture: 'PINCH', confidence: 0.86, capturedAt: now, targetRef: 'hud:command-deck' }, now);
  assert.ok(safe);
  assert.equal(safe.targetRef, 'hud:command-deck');
  assert.equal(createGestureIntent({ gesture: 'PINCH', confidence: 0.6, capturedAt: now, targetRef: null }, now), null);
  assert.equal(createGestureIntent({ gesture: 'OPEN_PALM', confidence: 0.9, capturedAt: now, targetRef: 'desktop:window' }, now)?.targetRef, null);
});

test('GESTURE-03: open palm and point require dwell, debounce duplicates, and rearm only after neutral rest', () => {
  const recognizer = new GestureEngine({ dwellMs: 200, neutralRearmMs: 300, cooldownMs: 500 });
  const open = landmarks();
  assert.equal(recognizer.update(open, 1000).event, null);
  assert.equal(recognizer.update(open, 1200).event?.gesture, 'OPEN_PALM');
  assert.equal(recognizer.update(open, 1400).event, null);

  const rest = landmarks({ open: false });
  recognizer.update(rest, 1500);
  recognizer.update(rest, 1800);
  recognizer.update(rest, 1950);
  recognizer.update(rest, 2100);
  const pointing = landmarks({ open: false, point: true });
  assert.equal(recognizer.update(pointing, 2200).event, null);
  assert.equal(recognizer.update(pointing, 2400).event, null);
  assert.equal(recognizer.update(pointing, 2600).event?.gesture, 'POINT_HOVER');
  assert.equal(recognizer.update(pointing, 2800).event, null);
});

test('GESTURE-04: pinch classification is bounded to geometry and tracking loss resets state', () => {
  const recognizer = new GestureEngine();
  recognizer.update(landmarks({ open: false }), 1000);
  recognizer.update(landmarks({ open: false }), 1400);
  recognizer.update(landmarks({ open: false, pinch: true }), 1500);
  recognizer.update(landmarks({ open: false, pinch: true }), 1600);
  recognizer.update(landmarks({ open: false, pinch: true }), 1800);
  const pinch = recognizer.update(landmarks({ open: false, pinch: true }), 1900);
  assert.equal(pinch.pose, 'PINCH');
  assert.equal(pinch.event?.gesture, 'PINCH');
  assert.equal(recognizer.update([], 2000).pose, 'TRACKING_LOST');
  assert.equal(recognizer.update(landmarks({ open: false, pinch: true }), 2100).event, null);
});

test('GESTURE-05: heuristic score is explicitly bounded; unknown and malformed landmark samples are ignored', () => {
  const recognizer = new GestureEngine();
  assert.equal(recognizer.update(Array(21).fill({ x: Number.NaN, y: 0.5 }), 1000).confidence, 0);
  const first = recognizer.update(landmarks(), 1200);
  assert.ok(first.confidence >= 0 && first.confidence <= 1);
  assert.equal(first.event, null);
});

test('GESTURE-06: a horizontal swipe emits one bounded navigation preview', () => {
  const recognizer = new GestureEngine({ cooldownMs: 500 });
  const start = landmarks({ open: false });
  start[8].x = 0.2;
  recognizer.update(start, 1000);
  const moved = landmarks({ open: false });
  moved[8].x = 0.95;
  assert.equal(recognizer.update(moved, 1100).event?.gesture, 'SWIPE_LEFT');
  assert.equal(recognizer.update(moved, 1200).event, null);
});

test('GESTURE-07: browser gesture subsystem has no backend, shell, file, or adapter execution path', () => {
  const files = ['gesture.js', 'gesture-worker.js', 'gesture-recognition.js', 'gesture-recognition-core.js', 'gesture-intent.js']
    .map((name) => readFileSync(new URL(`../src/companion/${name}`, import.meta.url), 'utf8'));
  const source = files.join('\n');
  assert.doesNotMatch(source, /\bfetch\s*\(/);
  assert.doesNotMatch(source, /\/api\/(?:request|approval|device|execute)/i);
  assert.doesNotMatch(source, /child_process|execFile|spawn\s*\(/i);
  assert.doesNotMatch(source, /src\/adapters|PolicyGateway|JarvisDeviceCrypto/i);
});
