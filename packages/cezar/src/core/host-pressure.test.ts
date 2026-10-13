import type { HostUsage } from '@open-mercato/cezar-contract';
import { describe, expect, it } from 'vitest';
import {
  CPU_HOT_SAMPLES,
  HostPressureGovernor,
  PRESSURE_EXIT_SAMPLES,
  PRESSURE_STALE_MS,
  memoryPressureLevel,
} from './host-pressure.ts';

const GIB = 1024 * 1024 * 1024;

function sample(availableGib: number, totalGib = 16, extra: Partial<HostUsage> = {}): HostUsage {
  return {
    sampledAt: new Date(0).toISOString(),
    cpuCount: 8,
    memTotalBytes: totalGib * GIB,
    memUsedBytes: (totalGib - availableGib) * GIB,
    memAvailableBytes: availableGib * GIB,
    ...extra,
  };
}

/** Feed `count` samples 2 s apart, returning the clock after the last one. */
function feed(governor: HostPressureGovernor, usage: HostUsage, count: number, from: number): number {
  let at = from;
  for (let i = 0; i < count; i += 1) {
    at += 2_000;
    governor.observe(usage, at);
  }
  return at;
}

describe('memoryPressureLevel', () => {
  it.each([
    [8, 16, 'normal'],
    [2, 16, 'elevated'],
    [0.5, 16, 'critical'],
    // 10 % of a big host is still 12.8 GiB of headroom — not pressure.
    [12.8, 128, 'normal'],
    [5, 128, 'elevated'],
    [1.5, 128, 'critical'],
  ] as const)('%d GiB free of %d is %s', (available, total, level) => {
    expect(memoryPressureLevel(sample(available, total))).toBe(level);
  });

  it('reads the cgroup when it has a finite memory limit', () => {
    const usage = sample(12, 16, {
      container: { source: 'cgroup-v2', memLimitBytes: 4 * GIB, memUsedBytes: 3.9 * GIB },
    });
    expect(memoryPressureLevel(usage)).toBe('critical');
  });
});

describe('HostPressureGovernor', () => {
  it('needs two samples to enter and six calm ones to leave', () => {
    const governor = new HostPressureGovernor();
    let at = feed(governor, sample(2), 1, 0);
    expect(governor.level(at)).toBe('normal');
    at = feed(governor, sample(2), 1, at);
    expect(governor.state(at)).toMatchObject({ level: 'elevated', reason: 'memory 88% used (2.0 GiB free)' });

    at = feed(governor, sample(8), PRESSURE_EXIT_SAMPLES - 1, at);
    expect(governor.level(at)).toBe('elevated');
    at = feed(governor, sample(8), 1, at);
    expect(governor.level(at)).toBe('normal');
  });

  it('a single spike resets nothing and enters nothing', () => {
    const governor = new HostPressureGovernor();
    let at = feed(governor, sample(2), 1, 0);
    at = feed(governor, sample(8), 1, at);
    at = feed(governor, sample(2), 1, at);
    expect(governor.level(at)).toBe('normal');
  });

  it('steps down from critical to the worst level seen in the calm streak', () => {
    const governor = new HostPressureGovernor();
    let at = feed(governor, sample(0.5), 2, 0);
    expect(governor.level(at)).toBe('critical');
    at = feed(governor, sample(2), PRESSURE_EXIT_SAMPLES, at);
    expect(governor.level(at)).toBe('elevated');
  });

  it('CPU only ever reads elevated, and only when sustained', () => {
    const governor = new HostPressureGovernor();
    const hot = sample(8, 16, { cpuPct: 99 });
    let at = feed(governor, hot, CPU_HOT_SAMPLES, 0);
    expect(governor.level(at)).toBe('normal');
    at = feed(governor, hot, 1, at);
    expect(governor.state(at)).toMatchObject({ level: 'elevated', reason: 'CPU at 99%' });
  });

  it('fails open: no sample for a while reads normal, and the streaks start over', () => {
    const governor = new HostPressureGovernor();
    let at = feed(governor, sample(0.5), 2, 0);
    expect(governor.level(at)).toBe('critical');
    at += PRESSURE_STALE_MS + 1;
    expect(governor.level(at)).toBe('normal');
    governor.observe(sample(0.5), at);
    expect(governor.level(at)).toBe('normal');
  });
});
