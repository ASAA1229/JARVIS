/**
 * Cross-module event and state synchronization (D2.20).
 *
 * A small in-process, typed publish/subscribe bus with a bounded replay buffer. Modules
 * (voice, agent/task core, desktop, Android command queue, sessions) publish facts about
 * what happened; other modules and authenticated clients observe them without importing
 * each other, which keeps the voice, agent, desktop and Android modules separated.
 *
 * Properties:
 * - Every event gets a monotonically increasing sequence number, so a client that polls
 *   with `since=<lastSeq>` can resynchronize after a gap without missing or duplicating.
 * - Events may be scoped to one device. A device only ever sees its own scoped events plus
 *   global ones (per-device session isolation); `deviceId` filtering is enforced in `since()`.
 * - Payloads are shallow, JSON-safe summaries chosen by the publisher. Secrets, audio and
 *   transcript text must never be published; keys that look sensitive are dropped here as a
 *   second line of defence.
 * - A throwing subscriber never affects the publisher or other subscribers.
 */

export type JarvisEventType =
  | 'task.state'
  | 'device.revoked'
  | 'device.paired'
  | 'session.ended'
  | 'voice.state'
  | 'approval.requested'
  | 'approval.resolved'
  | 'android.command'
  | 'ops.alert';

export interface JarvisEvent {
  seq: number;
  at: number;
  type: JarvisEventType;
  /** Present for device-scoped events; absent for global (owner/system) events. */
  deviceId?: string;
  data: Record<string, string | number | boolean | null>;
}

export type EventListener = (event: JarvisEvent) => void;

const SENSITIVE_KEY = /secret|token|password|credential|key|audio|transcript|authorization/i;
const MAX_STRING = 300;

function sanitize(data: Record<string, unknown>): JarvisEvent['data'] {
  const out: JarvisEvent['data'] = {};
  for (const [key, value] of Object.entries(data)) {
    if (SENSITIVE_KEY.test(key)) continue;
    if (value === null || typeof value === 'number' || typeof value === 'boolean') out[key] = value as number | boolean | null;
    else if (typeof value === 'string') out[key] = value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
  }
  return out;
}

export class EventBus {
  private seq = 0;
  private readonly buffer: JarvisEvent[] = [];
  private readonly listeners = new Set<EventListener>();

  constructor(private readonly capacity = 500, private readonly now: () => number = () => Date.now()) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error('Event buffer capacity must be a positive integer.');
  }

  publish(type: JarvisEventType, data: Record<string, unknown> = {}, deviceId?: string): JarvisEvent {
    const event: JarvisEvent = { seq: ++this.seq, at: this.now(), type, ...(deviceId ? { deviceId } : {}), data: sanitize(data) };
    this.buffer.push(event);
    if (this.buffer.length > this.capacity) this.buffer.shift();
    for (const listener of [...this.listeners]) {
      try { listener(event); } catch { /* a faulty observer must never break the publisher */ }
    }
    return event;
  }

  /** Subscribe to all future events. Returns an unsubscribe function. */
  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /**
   * Events after `since`, visible to the viewer: global events plus the viewer's own.
   * `owner` viewers (device-manage permission) also see every device's events.
   * `gap` is true when events older than the buffer were dropped, so the client must
   * perform a full state refresh instead of trusting the incremental stream.
   */
  since(since: number, viewer: { deviceId: string; owner: boolean }, limit = 200): { events: JarvisEvent[]; latestSeq: number; gap: boolean } {
    const cursor = Number.isFinite(since) && since > 0 ? Math.floor(since) : 0;
    const oldest = this.buffer.length ? this.buffer[0].seq : this.seq + 1;
    const gap = cursor + 1 < oldest && this.seq > 0 && cursor < this.seq;
    const visible = this.buffer.filter((event) => event.seq > cursor && (viewer.owner || !event.deviceId || event.deviceId === viewer.deviceId));
    return { events: visible.slice(0, Math.max(1, Math.min(limit, 500))), latestSeq: this.seq, gap };
  }

  latestSeq(): number { return this.seq; }
}
