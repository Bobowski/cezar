import type { HostUsage } from '@open-mercato/cezar-contract';
import { describe, expect, it, vi } from 'vitest';
import {
  HOST_ADMISSION_STAGGER_MS,
  HOST_RELIEF_COOLDOWN_MS,
  HOST_STEP_HOLD_MAX_MS,
  HOST_STEP_POLL_MS,
  WorkspaceSemaphore,
  hostAdmissionEnabled,
  type PressureReliefCandidate,
  type SemaphoreParticipant,
} from './semaphore.ts';

const GIB = 1024 * 1024 * 1024;
const usage = (availableGib: number): HostUsage => ({
  sampledAt: new Date(0).toISOString(),
  cpuCount: 8,
  memTotalBytes: 16 * GIB,
  memUsedBytes: (16 - availableGib) * GIB,
  memAvailableBytes: availableGib * GIB,
});
const CALM = usage(8);
const ELEVATED = usage(2);
const CRITICAL = usage(0.5);

/** A semaphore on a fake clock and a fake sampler, with one scriptable participant. */
function harness() {
  let now = 1_000_000;
  let listener: ((sample: HostUsage) => void) | undefined;
  let busy = 0;
  let queued = false;
  let candidates: PressureReliefCandidate[] = [];
  const pump = vi.fn();
  const semaphore = new WorkspaceSemaphore({
    hostPressure: {
      onHostUsage(next) {
        listener = next;
        return () => {
          listener = undefined;
        };
      },
    },
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
  });
  const participant: SemaphoreParticipant = {
    busySlots: () => busy,
    pump,
    oldestQueuedAt: () => (queued ? 1 : null),
    pressureReliefCandidates: () => candidates,
  };
  semaphore.register(participant);
  return {
    semaphore,
    pump,
    set: (next: { busy?: number; queued?: boolean; candidates?: PressureReliefCandidate[] }) => {
      if (next.busy !== undefined) busy = next.busy;
      if (next.queued !== undefined) queued = next.queued;
      if (next.candidates !== undefined) candidates = next.candidates;
    },
    advance: (ms: number) => {
      now += ms;
    },
    watching: () => listener !== undefined,
    feed: (sample: HostUsage, count = 1) => {
      for (let i = 0; i < count; i += 1) {
        now += 2_000;
        listener?.(sample);
      }
    },
  };
}

describe('host-pressure admission (spec 2026-10-13)', () => {
  it('without a host source there is no gate at all', async () => {
    const semaphore = new WorkspaceSemaphore();
    semaphore.register({ busySlots: () => 3, pump: () => {}, oldestQueuedAt: () => 1 });
    expect(semaphore.hostAdmission()).toBe('ok');
    expect(await semaphore.awaitStepHeadroom({ cancelled: () => false })).toBe('admitted');
  });

  it('samples the host only while there is work', () => {
    const h = harness();
    expect(h.semaphore.hostAdmission()).toBe('ok');
    expect(h.watching()).toBe(false);
    h.set({ busy: 1 });
    h.semaphore.hostAdmission();
    expect(h.watching()).toBe(true);
    h.set({ busy: 0 });
    h.feed(CALM);
    expect(h.watching()).toBe(false);
  });

  it('holds a queued run under pressure and re-pumps when the machine calms down', async () => {
    const h = harness();
    h.set({ busy: 1, queued: true });
    h.semaphore.hostAdmission();
    h.feed(ELEVATED, 2);
    expect(h.semaphore.hostAdmission()).toBe('pressure');
    expect(h.semaphore.hostAdmissionState()).toMatchObject({ level: 'elevated' });
    h.feed(CALM, 5);
    expect(h.pump).not.toHaveBeenCalled();
    h.feed(CALM);
    await Promise.resolve();
    expect(h.pump).toHaveBeenCalledTimes(1);
    expect(h.semaphore.hostAdmission()).toBe('ok');
  });

  it('a workspace holding no slot always admits, whatever the machine says', () => {
    const h = harness();
    h.set({ busy: 1, queued: true });
    h.semaphore.hostAdmission();
    h.feed(CRITICAL, 2);
    expect(h.semaphore.hostAdmission()).toBe('pressure');
    h.set({ busy: 0 });
    expect(h.semaphore.hostAdmission()).toBe('ok');
  });

  it('staggers starts on a calm machine', () => {
    const h = harness();
    h.set({ busy: 1, queued: true });
    h.semaphore.noteRunAdmitted();
    expect(h.semaphore.hostAdmission()).toBe('stagger');
    h.advance(HOST_ADMISSION_STAGGER_MS);
    expect(h.semaphore.hostAdmission()).toBe('ok');
  });

  it('holds a step while another run works, and lets it go once nothing else is running', async () => {
    const h = harness();
    h.set({ busy: 2 });
    h.semaphore.hostAdmission();
    h.feed(ELEVATED, 2);
    const onHold = vi.fn();
    let polls = 0;
    const outcome = await h.semaphore.awaitStepHeadroom({
      // The other run finishes during the third poll.
      cancelled: () => {
        polls += 1;
        if (polls === 3) h.set({ busy: 1 });
        return false;
      },
      onHold,
    });
    expect(outcome).toBe('admitted');
    expect(polls).toBe(3);
    expect(onHold).toHaveBeenCalledWith('memory 88% used (2.0 GiB free)');
    expect(h.semaphore.hostAdmissionState().heldSteps).toBe(0);
  });

  it('a lone run never waits at a step', async () => {
    const h = harness();
    h.set({ busy: 1 });
    h.semaphore.hostAdmission();
    h.feed(CRITICAL, 2);
    expect(await h.semaphore.awaitStepHeadroom({ cancelled: () => false })).toBe('admitted');
  });

  it('a held step is bounded by the clock and honours cancel', async () => {
    const h = harness();
    h.set({ busy: 2 });
    h.semaphore.hostAdmission();
    h.feed(ELEVATED, 2);
    let polls = 0;
    // Keep the level fresh: a real sampler ticks while the step waits.
    const timedOut = await h.semaphore.awaitStepHeadroom({
      cancelled: () => {
        polls += 1;
        h.feed(ELEVATED);
        return false;
      },
    });
    expect(timedOut).toBe('timeout');
    expect(polls).toBeLessThanOrEqual(HOST_STEP_HOLD_MAX_MS / HOST_STEP_POLL_MS);
    expect(await h.semaphore.awaitStepHeadroom({ cancelled: () => true })).toBe('cancelled');
  });

  it('critical pressure pauses the heaviest working run, once per cooldown, never the only one', () => {
    const h = harness();
    const light = { rssBytes: 1 * GIB, startedAtMs: 1, pause: vi.fn() };
    const heavy = { rssBytes: 4 * GIB, startedAtMs: 2, pause: vi.fn() };
    h.set({ busy: 2, candidates: [heavy] });
    h.semaphore.hostAdmission();
    h.feed(CRITICAL, 2);
    expect(heavy.pause).not.toHaveBeenCalled();

    h.set({ candidates: [light, heavy] });
    h.feed(CRITICAL);
    expect(heavy.pause).toHaveBeenCalledTimes(1);
    expect(heavy.pause).toHaveBeenCalledWith('memory 97% used (0.5 GiB free)');
    h.feed(CRITICAL, 3);
    expect(heavy.pause).toHaveBeenCalledTimes(1);
    expect(light.pause).not.toHaveBeenCalled();

    // Still critical a cooldown later: the next-heaviest decision is taken afresh.
    h.feed(CRITICAL, HOST_RELIEF_COOLDOWN_MS / 2_000);
    expect(heavy.pause).toHaveBeenCalledTimes(2);
  });
});

describe('hostAdmissionEnabled', () => {
  it.each([
    [{}, true],
    [{ CEZ_HOST_ADMISSION: '0' }, false],
    [{ CEZ_DRY_RUN: '1' }, false],
    [{ CEZ_DRY_RUN: '1', CEZ_HOST_ADMISSION: '1' }, true],
  ])('%j → %s', (env, expected) => {
    expect(hostAdmissionEnabled(env)).toBe(expected);
  });
});
