/**
 * Adaptive resource profiles (JARVIS-US-061).
 *
 * Samples CPU, free RAM and battery on the existing laptop and selects an
 * idle / normal / intensive profile automatically (or the owner pins one). The
 * profile sets limits that the site gateway, agents and scheduler read on every
 * request, and a heavy-work registry lets the owner see and stop expensive work.
 * No new hardware or paid infrastructure is assumed.
 */
import { execFile } from 'node:child_process';
import { cpus, freemem, platform, totalmem } from 'node:os';

export type ProfileName = 'idle' | 'normal' | 'intensive';
export type ProfileMode = 'auto' | ProfileName;

export interface BatteryReading {
  percent: number;
  charging: boolean;
}

export interface ResourceReadings {
  cpuPercent: number;
  freeMemPercent: number;
  freeMemMB: number;
  totalMemMB: number;
  /** null when no battery is present or it could not be read. */
  battery: BatteryReading | null;
  sampledAt: number;
}

export interface ProfileLimits {
  gatewayMaxConcurrentTotal: number;
  gatewayMaxConcurrentPerClient: number;
  /** Advisory-agent model calls per device per 5 minutes. */
  agentRequestsPer5Min: number;
  /** Whether recurring scheduled background jobs may run now. */
  recurringJobsAllowed: boolean;
}

export const PROFILE_LIMITS: Record<ProfileName, ProfileLimits> = {
  idle: { gatewayMaxConcurrentTotal: 1, gatewayMaxConcurrentPerClient: 1, agentRequestsPer5Min: 5, recurringJobsAllowed: false },
  normal: { gatewayMaxConcurrentTotal: 2, gatewayMaxConcurrentPerClient: 1, agentRequestsPer5Min: 20, recurringJobsAllowed: true },
  intensive: { gatewayMaxConcurrentTotal: 4, gatewayMaxConcurrentPerClient: 2, agentRequestsPer5Min: 40, recurringJobsAllowed: true },
};

export interface HeavyWorkItem {
  id: string;
  kind: 'model_inference' | 'indexing' | 'background_job' | 'other';
  label: string;
  startedAt: number;
}

interface HeavyWorkEntry extends HeavyWorkItem {
  cancel: () => void;
}

/** Choose a profile from readings: protect battery and a busy machine first. */
export function selectProfile(readings: ResourceReadings): { profile: ProfileName; reason: string } {
  const onBattery = readings.battery !== null && !readings.battery.charging;
  if (onBattery && readings.battery!.percent < 30) return { profile: 'idle', reason: `on battery at ${readings.battery!.percent}%` };
  if (readings.cpuPercent >= 85) return { profile: 'idle', reason: `CPU busy (${readings.cpuPercent}%)` };
  if (readings.freeMemPercent < 10) return { profile: 'idle', reason: `low free memory (${readings.freeMemPercent}%)` };
  if (!onBattery && readings.cpuPercent < 40 && readings.freeMemPercent >= 30) {
    return { profile: 'intensive', reason: 'on AC power with spare CPU and memory' };
  }
  return { profile: 'normal', reason: onBattery ? 'on battery' : 'moderate load' };
}

type CpuTimes = { idle: number; total: number };

function cpuTimes(): CpuTimes {
  let idle = 0;
  let total = 0;
  for (const cpu of cpus()) {
    const times = cpu.times;
    idle += times.idle;
    total += times.user + times.nice + times.sys + times.irq + times.idle;
  }
  return { idle, total };
}

/** Battery via PowerShell CIM on Windows (bounded by a timeout); null elsewhere or on failure. */
function readWindowsBattery(): Promise<BatteryReading | null> {
  if (platform() !== 'win32') return Promise.resolve(null);
  const script = '$b = Get-CimInstance Win32_Battery -ErrorAction SilentlyContinue | Select-Object -First 1; ' +
    'if ($b) { [Console]::Out.Write(\'{"percent":\' + [int]$b.EstimatedChargeRemaining + \',"status":\' + [int]$b.BatteryStatus + \'}\') }';
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 4000, windowsHide: true }, (error, stdout) => {
      if (error || !stdout.trim()) return resolve(null);
      try {
        const parsed = JSON.parse(stdout) as { percent?: unknown; status?: unknown };
        const percent = Number(parsed.percent);
        const status = Number(parsed.status);
        if (!Number.isFinite(percent)) return resolve(null);
        // Win32_Battery BatteryStatus: 1 = discharging; 2 = on AC; 6-9 = charging states.
        resolve({ percent: Math.max(0, Math.min(100, percent)), charging: status !== 1 });
      } catch {
        resolve(null);
      }
    });
  });
}

let heavyCounter = 0;

export class ResourceManager {
  private mode: ProfileMode = 'auto';
  private readings: ResourceReadings;
  private autoReason = 'not sampled yet';
  private previousCpu: CpuTimes = cpuTimes();
  private batteryCache: { value: BatteryReading | null; at: number } | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly heavyWork = new Map<string, HeavyWorkEntry>();

  constructor(
    private readonly batteryReader: () => Promise<BatteryReading | null> = readWindowsBattery,
    private readonly now: () => number = Date.now,
  ) {
    this.readings = {
      cpuPercent: 0,
      freeMemPercent: Math.round((freemem() / totalmem()) * 100),
      freeMemMB: Math.round(freemem() / 1048576),
      totalMemMB: Math.round(totalmem() / 1048576),
      battery: null,
      sampledAt: this.now(),
    };
  }

  /** Take a fresh reading. Battery is cached for 60 s because PowerShell is slow. */
  async sample(): Promise<ResourceReadings> {
    const current = cpuTimes();
    const totalDelta = current.total - this.previousCpu.total;
    const idleDelta = current.idle - this.previousCpu.idle;
    this.previousCpu = current;
    const cpuPercent = totalDelta > 0 ? Math.round(100 * (1 - idleDelta / totalDelta)) : this.readings.cpuPercent;
    if (!this.batteryCache || this.now() - this.batteryCache.at > 60_000) {
      this.batteryCache = { value: await this.batteryReader().catch(() => null), at: this.now() };
    }
    const free = freemem();
    const total = totalmem();
    this.readings = {
      cpuPercent: Math.max(0, Math.min(100, cpuPercent)),
      freeMemPercent: Math.round((free / total) * 100),
      freeMemMB: Math.round(free / 1048576),
      totalMemMB: Math.round(total / 1048576),
      battery: this.batteryCache.value,
      sampledAt: this.now(),
    };
    this.autoReason = selectProfile(this.readings).reason;
    return { ...this.readings };
  }

  start(intervalMs = 15_000): void {
    if (this.timer) return;
    void this.sample();
    this.timer = setInterval(() => { void this.sample(); }, intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  setMode(mode: ProfileMode): void {
    if (!['auto', 'idle', 'normal', 'intensive'].includes(mode)) throw new Error('Unknown resource profile.');
    this.mode = mode;
  }

  current(): { mode: ProfileMode; profile: ProfileName; reason: string } {
    if (this.mode !== 'auto') return { mode: this.mode, profile: this.mode, reason: 'pinned by the owner' };
    const selected = selectProfile(this.readings);
    return { mode: 'auto', profile: selected.profile, reason: selected.reason };
  }

  limits(): ProfileLimits {
    return { ...PROFILE_LIMITS[this.current().profile] };
  }

  /** Register expensive work so the owner can see and stop it. Call done() when finished. */
  registerHeavyWork(kind: HeavyWorkItem['kind'], label: string, cancel: () => void): { id: string; done: () => void } {
    const id = `hw-${(heavyCounter++).toString(36)}`;
    this.heavyWork.set(id, { id, kind, label: label.slice(0, 80), startedAt: this.now(), cancel });
    return { id, done: () => { this.heavyWork.delete(id); } };
  }

  listHeavyWork(): HeavyWorkItem[] {
    return [...this.heavyWork.values()].map(({ cancel: _cancel, ...item }) => item);
  }

  /** Stop one item (by id) or all heavy work. Returns how many were cancelled. */
  stopHeavyWork(id?: string): number {
    let stopped = 0;
    for (const [key, entry] of this.heavyWork) {
      if (id && key !== id) continue;
      try { entry.cancel(); } catch { /* cancellation is best-effort */ }
      this.heavyWork.delete(key);
      stopped += 1;
    }
    return stopped;
  }

  snapshot(): { mode: ProfileMode; profile: ProfileName; reason: string; limits: ProfileLimits; readings: ResourceReadings; heavyWork: HeavyWorkItem[]; autoSelectionReason: string } {
    const current = this.current();
    return {
      ...current,
      limits: this.limits(),
      readings: { ...this.readings, ...(this.readings.battery ? { battery: { ...this.readings.battery } } : {}) },
      heavyWork: this.listHeavyWork(),
      autoSelectionReason: this.autoReason,
    };
  }
}

/** Process-wide manager shared by the gateway, agents, scheduler and owner routes. */
export const resourceManager = new ResourceManager();
