import type { HostUsage } from '@open-mercato/cezar-contract';

/**
 * Host pressure — the level the admission gate reads (spec
 * `.ai/specs/2026-10-13-host-pressure-admission.md`). Pure: samples in, a level out, no timer and
 * no I/O, so every rule is table-tested without a machine.
 */

export type HostPressureLevel = 'normal' | 'elevated' | 'critical';

const GIB = 1024 * 1024 * 1024;
/** Headroom is BOTH a share and an absolute: 15 % of a 128 GiB host is not pressure. */
export const ELEVATED_AVAILABLE_SHARE = 0.15;
export const ELEVATED_AVAILABLE_BYTES = 6 * GIB;
export const CRITICAL_AVAILABLE_SHARE = 0.05;
export const CRITICAL_AVAILABLE_BYTES = 2 * GIB;
/** CPU never crashes a machine, so it only ever reads `elevated`, and only when sustained. */
export const CPU_HOT_PCT = 95;
export const CPU_HOT_SAMPLES = 5;
/** Two samples to enter a worse level, six to leave it: late in, slow out, no flapping. */
export const PRESSURE_ENTER_SAMPLES = 2;
export const PRESSURE_EXIT_SAMPLES = 6;
/** No sample for this long reads as `normal` — a dead sampler must never hold the queue. */
export const PRESSURE_STALE_MS = 10_000;

const RANK: Record<HostPressureLevel, number> = { normal: 0, elevated: 1, critical: 2 };

export interface HostMemoryReading {
  totalBytes: number;
  availableBytes: number;
}

/** The process's own cgroup when it has a finite limit with a readable usage, else the host. */
export function hostMemoryReading(usage: HostUsage): HostMemoryReading | undefined {
  const limit = usage.container?.memLimitBytes;
  const used = usage.container?.memUsedBytes;
  if (limit !== undefined && used !== undefined) {
    return { totalBytes: limit, availableBytes: Math.max(0, limit - used) };
  }
  if (!(usage.memTotalBytes > 0)) return undefined;
  return { totalBytes: usage.memTotalBytes, availableBytes: usage.memAvailableBytes };
}

/** One sample's memory level, with no history. */
export function memoryPressureLevel(usage: HostUsage): HostPressureLevel {
  const memory = hostMemoryReading(usage);
  if (!memory) return 'normal';
  const share = memory.availableBytes / memory.totalBytes;
  if (share <= CRITICAL_AVAILABLE_SHARE && memory.availableBytes <= CRITICAL_AVAILABLE_BYTES) return 'critical';
  if (share <= ELEVATED_AVAILABLE_SHARE && memory.availableBytes <= ELEVATED_AVAILABLE_BYTES) return 'elevated';
  return 'normal';
}

const formatGib = (bytes: number): string => `${(bytes / GIB).toFixed(1)} GiB`;

export interface HostPressureState {
  level: HostPressureLevel;
  /** Epoch ms the current non-normal level began. */
  since?: number;
  /** Human one-liner for notes and the readout, e.g. `memory 91% used (1.4 GiB free)`. */
  reason?: string;
}

export class HostPressureGovernor {
  private current: HostPressureLevel = 'normal';
  private since: number | undefined;
  private reason: string | undefined;
  private lastAt = 0;
  private cpuHot = 0;
  private worse = 0;
  private calmer = 0;
  /** The worst reading inside the calm streak — the level the streak steps down TO. */
  private calmerCeiling: HostPressureLevel = 'normal';

  observe(usage: HostUsage, at: number): void {
    // A gap means the streaks describe a different moment; start them over.
    if (at - this.lastAt > PRESSURE_STALE_MS) this.reset();
    this.lastAt = at;
    const cpuPct = usage.container?.cpuPct ?? usage.cpuPct;
    this.cpuHot = cpuPct !== undefined && cpuPct >= CPU_HOT_PCT ? this.cpuHot + 1 : 0;
    const memory = memoryPressureLevel(usage);
    const cpu: HostPressureLevel = this.cpuHot >= CPU_HOT_SAMPLES ? 'elevated' : 'normal';
    const raw = RANK[memory] >= RANK[cpu] ? memory : cpu;

    if (RANK[raw] > RANK[this.current]) {
      this.worse += 1;
      this.calmer = 0;
      if (this.worse >= PRESSURE_ENTER_SAMPLES) this.move(raw, at);
    } else if (RANK[raw] < RANK[this.current]) {
      this.calmerCeiling = this.calmer === 0 || RANK[raw] > RANK[this.calmerCeiling] ? raw : this.calmerCeiling;
      this.calmer += 1;
      this.worse = 0;
      if (this.calmer >= PRESSURE_EXIT_SAMPLES) this.move(this.calmerCeiling, at);
    } else {
      this.worse = 0;
      this.calmer = 0;
    }
    if (this.current !== 'normal') this.reason = describe(usage, memory !== 'normal' || cpu === 'normal');
  }

  state(at: number): HostPressureState {
    if (this.current === 'normal' || at - this.lastAt > PRESSURE_STALE_MS) return { level: 'normal' };
    return {
      level: this.current,
      ...(this.since === undefined ? {} : { since: this.since }),
      ...(this.reason === undefined ? {} : { reason: this.reason }),
    };
  }

  level(at: number): HostPressureLevel {
    return this.state(at).level;
  }

  reset(): void {
    this.current = 'normal';
    this.since = undefined;
    this.reason = undefined;
    this.cpuHot = 0;
    this.worse = 0;
    this.calmer = 0;
  }

  private move(to: HostPressureLevel, at: number): void {
    this.current = to;
    this.since = to === 'normal' ? undefined : at;
    if (to === 'normal') this.reason = undefined;
    this.worse = 0;
    this.calmer = 0;
  }
}

function describe(usage: HostUsage, byMemory: boolean): string {
  const memory = hostMemoryReading(usage);
  if (byMemory && memory) {
    const usedPct = Math.round((1 - memory.availableBytes / memory.totalBytes) * 100);
    return `memory ${usedPct}% used (${formatGib(memory.availableBytes)} free)`;
  }
  const cpuPct = usage.container?.cpuPct ?? usage.cpuPct;
  return cpuPct === undefined ? 'CPU saturated' : `CPU at ${Math.round(cpuPct)}%`;
}
