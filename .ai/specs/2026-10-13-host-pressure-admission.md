# Host-pressure admission - `maxParallel` becomes a ceiling

> Slug: `host-pressure-admission` · Status: **implemented on `brutus`** · Supersedes the deferred
> item "Adaptive ceilings for ORDINARY runs" in `2026-09-20-adaptive-admission-governor.md` (that
> draft covers dispatch children on Linux cgroups only and was never implemented).

## TLDR

`maxParallel` says how many tasks MAY run; the machine says how many CAN. While the host is short
of memory or its CPU is pinned, cezar keeps queued tasks queued, makes a running task wait before
its next workflow step, starts tasks a few seconds apart, and - under critical memory pressure -
pauses the heaviest running task. No setting: fixed thresholds, on by default,
`CEZ_HOST_ADMISSION=0` turns it off.

## Problem

- The only brake was a count. Six tasks on a 16 GiB laptop start together whether or not the
  machine can carry them, and a test suite the user runs by hand is invisible to the count.
- `memoryLimitMb` is per task, off by default, and needs a number nobody knows in advance.
- Host telemetry (`core/host-usage.ts`) was a display. Nothing consumed it.

## Design

### 1. The signal

One `HostUsage` sample every 2 s from the existing sampler, taken only while some manager has a
run live or queued. Memory is the process's own cgroup when it has a finite limit, else the host.
Because the reading is the MACHINE's, work cezar did not start (a terminal, a service, another
app) counts without cezar knowing about it.

| Level | Memory available | CPU |
| --- | --- | --- |
| `elevated` | <= 15 % AND <= 6 GiB | >= 95 % for 5 consecutive samples |
| `critical` | <= 5 % AND <= 2 GiB | never |

Both memory terms must hold: 15 % of a 128 GiB host is not pressure. Two samples to enter a worse
level, six to leave it. No sample for 10 s reads `normal`.

### 2. The queue gate

`pump()` asks the workspace semaphore last, after the slot caps and the account hold:

- `pressure` - the level is not `normal`: the run stays queued, with one note saying why.
- `stagger` - another run started less than 6 s ago: the newcomer's footprint is not visible yet.
- A workspace holding **no slot always admits**. Pressure cezar did not cause must not wedge its
  queue, and this is also what keeps the queue watchdog's contract intact.

A refused queue is re-pumped by the first sample that would admit it; a finishing run pumps as
before.

### 3. The step gate

Before every agent/check node after a run's first, the walk waits while the level is not `normal`
AND another run is still making progress. Exits, all on by default: the machine calms down; every
other run finishes or is itself held (then exactly one held step goes); cancel; a 10-minute clock
bound, after which the step starts anyway. The wait polls itself - it depends on no wake-up.

### 4. Critical relief

At `critical`, with at least two runs working, the heaviest (process-tree RSS, newest on a tie)
is paused through the existing memory-guard path: its session closes, the run is resumable with
Continue. One pause per 30 s. Never the only working run, never a parked session, never a check
step (it cannot be continued).

### 5. Readout

`admission: { state, since?, reason?, heldSteps? }` on the existing host payload (the `host`
topic and `GET /api/v1/workspace/host-usage`), present ONLY while the gate is holding - a calm
machine's payload is unchanged. The Machine card shows one line.

## Where it lives

- `core/host-pressure.ts` - thresholds and the hysteresis state machine, pure.
- `workspace/semaphore.ts` - the gate: `hostAdmission()`, `awaitStepHeadroom()`, the relief pick.
  It already owns every workspace-wide count; the sampler reports to it, never the reverse.
- `workflows/run.ts` - three call sites: `startable` in `pump()`, the node loop in
  `executeGraph`, and `pressureReliefCandidates`.
- A `WorkspaceSemaphore` built without `hostPressure` has no gate. Only `index.ts` wires it, so
  tests and bare managers never read the real machine.

## What it does not do

- It cannot shrink memory already taken: four admitted tasks that grow inside one long agent step
  are only reachable by the critical pause.
- A paused task is not resumed automatically when pressure clears.
- Windows offers no commit-charge reading through `os`; the gate sees physical memory only.
- A fork's branches are not gated individually.

## Default-path review (AGENTS.md § Changing a mechanism that already works)

- Old scenario, shipped defaults (`maxParallel: 2`), calm machine: the second task starts 6 s
  after the first instead of at once. Nothing else changes.
- Old scenario, machine permanently above 85 % memory with little headroom: tasks run one at a
  time instead of two. That is the feature; the Machine card and the queue note say so, and
  `CEZ_HOST_ADMISSION=0` restores the fixed cap.
- No state was removed. Every hold added has a clock or a count behind its exit (§2, §3).
- `CEZ_DRY_RUN=1` keeps the gate off (mock agents weigh nothing) unless `CEZ_HOST_ADMISSION=1`.
