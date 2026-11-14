/**
 * In-memory sliding-window limiter for authenticated advisory model calls.
 * Action requests and local conversational responses do not consume this budget.
 */
export interface AgentRequestLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

interface DeviceWindow {
  timestamps: number[];
  lastSeenAt: number;
}

export class AgentRequestLimiter {
  private readonly windows = new Map<string, DeviceWindow>();

  constructor(
    /** A number, or a function read per call so resource profiles (US-061) can adjust it. */
    private readonly limit: number | (() => number) = 20,
    private readonly windowMs = 5 * 60 * 1000,
    private readonly maxTrackedDevices = 500,
  ) {}

  consume(deviceId: string, now = Date.now()): AgentRequestLimitResult {
    if (!deviceId || !Number.isFinite(now)) {
      return { allowed: false, remaining: 0, retryAfterSeconds: Math.ceil(this.windowMs / 1000) };
    }

    const cutoff = now - this.windowMs;
    let window = this.windows.get(deviceId);

    if (window) {
      window.timestamps = window.timestamps.filter((timestamp) => timestamp > cutoff);
      window.lastSeenAt = now;
      // Refresh insertion order for predictable least-recently-seen cleanup.
      this.windows.delete(deviceId);
      this.windows.set(deviceId, window);
    } else {
      this.pruneExpired(cutoff);
      if (this.windows.size >= this.maxTrackedDevices) {
        return { allowed: false, remaining: 0, retryAfterSeconds: Math.ceil(this.windowMs / 1000) };
      }
      window = { timestamps: [], lastSeenAt: now };
      this.windows.set(deviceId, window);
    }

    const limit = typeof this.limit === 'function' ? this.limit() : this.limit;
    if (window.timestamps.length >= limit) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((window.timestamps[0] + this.windowMs - now) / 1000),
      );
      return { allowed: false, remaining: 0, retryAfterSeconds };
    }

    window.timestamps.push(now);
    return {
      allowed: true,
      remaining: Math.max(0, limit - window.timestamps.length),
      retryAfterSeconds: 0,
    };
  }

  private pruneExpired(cutoff: number): void {
    for (const [deviceId, window] of this.windows) {
      window.timestamps = window.timestamps.filter((timestamp) => timestamp > cutoff);
      if (window.timestamps.length === 0 && window.lastSeenAt <= cutoff) {
        this.windows.delete(deviceId);
      }
    }
  }
}
