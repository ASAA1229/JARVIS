import { postEpisode, type PostResult } from './client';
import { finalizeEpisode, type Episode, type FinalizeOptions } from './episodes';
import type { OfflineQueue } from './queue';

export type Status = 'capturing' | 'paused' | 'offline' | 'no-key' | 'auth-failed';

export interface SentRecord { at: string; status: 'sent' | 'rejected'; detail?: string; episode: unknown }

export interface PipelineConfig {
  baseUrl(): string;
  ingestKey(): Promise<string | undefined>;
  finalize(): FinalizeOptions;
  paused(): boolean;
}

/**
 * Every captured episode passes through here: finalize (exclude + redact) -> durable queue -> send to loopback JARVIS.
 * Nothing is captured while paused or until an ingest key exists. The queue holds only redacted episodes.
 */
export class Pipeline {
  public status: Status = 'capturing';
  public readonly sent: SentRecord[] = [];
  private flushing = false;
  private recent: Array<{ id: string; endedAt: number }> = [];
  public onChange: () => void = () => undefined;

  constructor(private readonly queue: OfflineQueue, private readonly config: PipelineConfig, private readonly post: typeof postEpisode = postEpisode) {}

  /** Ids of episodes ended in the last `windowMs`, used to link a commit to the work that led to it. */
  recentEpisodeIds(windowMs: number, now = Date.now()): string[] {
    return this.recent.filter((r) => now - r.endedAt <= windowMs).map((r) => r.id);
  }

  async submit(episode: Episode): Promise<boolean> {
    if (this.config.paused()) { this.status = 'paused'; this.onChange(); return false; }
    if (!(await this.config.ingestKey())) { this.status = 'no-key'; this.onChange(); return false; }
    const clean = finalizeEpisode(episode, this.config.finalize());
    if (!clean) return false;
    this.recent.push({ id: clean.id, endedAt: Date.parse(clean.endedAt ?? clean.startedAt) || Date.now() });
    this.recent = this.recent.slice(-100);
    if (!this.queue.enqueue(clean)) return false;
    void this.flush();
    return true;
  }

  async flush(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      const key = await this.config.ingestKey();
      if (!key) { this.status = 'no-key'; return; }
      for (const item of [...this.queue.list()]) {
        let result: PostResult;
        try { result = await this.post(this.config.baseUrl(), key, item.episode); }
        catch (error) { result = { kind: 'retry', status: 0, error: error instanceof Error ? error.message : 'blocked' }; }
        if (result.kind === 'ok') {
          this.queue.remove(item.qid);
          this.record({ at: new Date().toISOString(), status: 'sent', episode: item.episode });
          this.status = this.config.paused() ? 'paused' : 'capturing';
        } else if (result.kind === 'rejected') {
          this.queue.remove(item.qid);
          this.record({ at: new Date().toISOString(), status: 'rejected', detail: result.error, episode: item.episode });
        } else {
          this.status = result.kind === 'auth' ? 'auth-failed' : 'offline';
          break;
        }
      }
      if (!this.queue.length && this.status === 'offline') this.status = 'capturing';
    } finally {
      this.flushing = false;
      if (this.config.paused()) this.status = 'paused';
      this.onChange();
    }
  }

  private record(entry: SentRecord): void {
    this.sent.push(entry);
    if (this.sent.length > 50) this.sent.shift();
  }
}
