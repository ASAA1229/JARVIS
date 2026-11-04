const FINGERS = [
  { tip: 8, pip: 6 }, { tip: 12, pip: 10 },
  { tip: 16, pip: 14 }, { tip: 20, pip: 18 },
];

const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

function validLandmarks(points) {
  return Array.isArray(points) && points.length === 21 && points.every((point) =>
    point && Number.isFinite(point.x) && Number.isFinite(point.y) &&
    point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1);
}

function pose(points) {
  const extended = FINGERS.map(({ tip, pip }) => points[tip].y < points[pip].y - 0.025);
  if (extended.every(Boolean)) return 'OPEN_PALM';
  const palmWidth = distance(points[5], points[17]);
  const pinchRatio = palmWidth > 0.01 ? distance(points[4], points[8]) / palmWidth : 1;
  if (pinchRatio < 0.32) return 'PINCH';
  if (extended[0] && !extended[1] && !extended[2] && !extended[3]) return 'POINT_HOVER';
  return 'NEUTRAL';
}

/** Geometry rules are previews only; scores are heuristic margins, not model probabilities. */
class GestureEngine {
  constructor({ dwellMs = 220, neutralRearmMs = 300, cooldownMs = 700 } = {}) {
    this.dwellMs = dwellMs;
    this.neutralRearmMs = neutralRearmMs;
    this.cooldownMs = cooldownMs;
    this.activePose = null;
    this.poseSince = 0;
    this.lastGestureAt = -Infinity;
    this.armed = true;
    this.history = [];
    this.smoothed = null;
  }

  reset() {
    this.activePose = null;
    this.poseSince = 0;
    this.armed = true;
    this.history = [];
    this.smoothed = null;
    this.lastGestureAt = -Infinity;
  }

  update(points, capturedAt) {
    if (!Number.isSafeInteger(capturedAt) || !validLandmarks(points)) {
      this.reset();
      return { pose: 'TRACKING_LOST', confidence: 0, event: null, cursor: null, points: null };
    }
    const next = points.map(({ x, y, z = 0 }) => ({ x, y, z: Number.isFinite(z) ? z : 0 }));
    this.smoothed = this.smoothed
      ? next.map((point, index) => ({
          x: this.smoothed[index].x * 0.55 + point.x * 0.45,
          y: this.smoothed[index].y * 0.55 + point.y * 0.45,
          z: this.smoothed[index].z * 0.55 + point.z * 0.45,
        }))
      : next;

    const current = pose(this.smoothed);
    const cursor = { x: 1 - this.smoothed[8].x, y: this.smoothed[8].y };
    this.history.push({ at: capturedAt, x: cursor.x, y: cursor.y });
    this.history = this.history.filter((sample) => capturedAt - sample.at <= 500);

    let gesture = current;
    let confidence = 0.86;
    if (current === 'NEUTRAL' && this.history.length >= 2) {
      const first = this.history[0];
      const dx = cursor.x - first.x;
      const dy = cursor.y - first.y;
      if (Math.abs(dx) >= 0.22 && Math.abs(dy) <= 0.12) {
        gesture = dx < 0 ? 'SWIPE_LEFT' : 'SWIPE_RIGHT';
        confidence = Math.min(0.98, 0.82 + Math.abs(dx) * 0.5);
      }
    }

    if (gesture === 'NEUTRAL') {
      if (this.activePose !== 'NEUTRAL') {
        this.activePose = 'NEUTRAL';
        this.poseSince = capturedAt;
      }
      if (capturedAt - this.poseSince >= this.neutralRearmMs) this.armed = true;
      return { pose: 'NEUTRAL', confidence: 1, event: null, cursor, points: this.smoothed };
    }

    if (gesture !== this.activePose) {
      this.activePose = gesture;
      this.poseSince = capturedAt;
    }
    if (!this.armed || capturedAt - this.lastGestureAt < this.cooldownMs ||
        gesture.startsWith('SWIPE_') || capturedAt - this.poseSince < this.dwellMs) {
      if (gesture.startsWith('SWIPE_') && this.armed && capturedAt - this.lastGestureAt >= this.cooldownMs) {
        this.lastGestureAt = capturedAt;
        this.armed = false;
        return { pose: gesture, confidence, event: { gesture, confidence, capturedAt }, cursor, points: this.smoothed };
      }
      return { pose: gesture, confidence, event: null, cursor, points: this.smoothed };
    }

    this.lastGestureAt = capturedAt;
    this.armed = false;
    return { pose: gesture, confidence, event: { gesture, confidence, capturedAt }, cursor, points: this.smoothed };
  }
}

globalThis.JarvisGestureEngine = GestureEngine;
