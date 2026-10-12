import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Service, ServicePatch, ServicePin, ServicePinInput } from '@open-mercato/cezar-contract';
import type { DetectedUrls } from '../server/terminal/detected-urls.ts';
import { serviceTerminalOwner, type TerminalRead, type TerminalSessions } from '../server/terminal/sessions.ts';
import { loadServices, newServiceId, saveServices } from './store.ts';

/**
 * A project's services at run time (spec `.ai/specs/2026-10-11-project-services.md` §3.3–3.4).
 *
 * Each running service is one PTY session of the shared registry, so "stop" is the registry's
 * process-tree kill and a cezar shutdown stops them with every other terminal. What this adds is
 * the state between sessions: a service that ended keeps its exit code and last output until the
 * user acts, and which pins were running survives a restart as an OFFER to resume.
 *
 * Transitions, and who fires each:
 *   stopped|exited → running   the user (start, restart, resume)
 *   stopped|exited → exited    the spawn failing — carries the reason
 *   running → stopped          the user (stop, restart), or cezar shutting down
 *   running → exited           the process ending on its own — carries its exit code
 * Nothing restarts a service on its own; an auto-restart loop is a state nobody asked to enter.
 */

export interface ServiceProject {
  id: string;
  root: string;
  dataDir: string;
}

interface Runtime {
  status: 'running' | 'stopped' | 'exited';
  sessionId: string | null;
  exitCode: number | null;
  reason: string | null;
  startedAt: string | null;
  /** The last session's scrollback, kept after the session itself is gone. */
  last: { data: string; end: number } | null;
  release: (() => void) | null;
}

export type ServiceResult<T> = { ok: true; value: T } | { ok: false; status: 404 | 409; error: string };
const refuse = (status: 404 | 409, error: string) => ({ ok: false as const, status, error });

const idle = (): Runtime => ({ status: 'stopped', sessionId: null, exitCode: null, reason: null, startedAt: null, last: null, release: null });

export const serviceOutputTopic = (sessionId: string): string => `terminal:${sessionId}`;

export class ProjectServices {
  private runtime = new Map<string, Runtime>();

  /** `changed` fires on every state change, with the project it happened in. `env` is what a
   *  service's process is told on top of the server's own environment. */
  constructor(
    private readonly sessions: TerminalSessions,
    private readonly urls: DetectedUrls,
    private readonly changed: (projectId: string) => void = () => {},
    private readonly env: () => Record<string, string> = () => ({}),
    private readonly onSession: (sessionId: string) => void = () => {},
  ) {}

  private key = (project: ServiceProject, id: string): string => serviceTerminalOwner(project.id, id);
  private state(project: ServiceProject, id: string): Runtime {
    const key = this.key(project, id);
    let state = this.runtime.get(key);
    if (!state) {
      state = idle();
      this.runtime.set(key, state);
    }
    return state;
  }

  async pins(project: ServiceProject): Promise<{ services: ServicePin[]; lastRunning: string[] }> {
    return loadServices(project.dataDir);
  }

  async list(project: ServiceProject): Promise<{ services: Service[]; lastRunning: string[] }> {
    const { services, lastRunning } = await loadServices(project.dataDir);
    const out: Service[] = [];
    for (const pin of services) {
      const state = this.state(project, pin.id);
      out.push({
        ...pin,
        status: state.status,
        exitCode: state.exitCode,
        reason: state.reason,
        startedAt: state.startedAt,
        urls: state.status === 'running' ? await this.urls.refresh(this.key(project, pin.id)) : [],
        topic: state.sessionId ? serviceOutputTopic(state.sessionId) : null,
      });
    }
    // The offer to resume is about a stack that is DOWN; once anything runs it is stale.
    const anyRunning = out.some((service) => service.status === 'running');
    return { services: out, lastRunning: anyRunning ? [] : lastRunning };
  }

  async pin(project: ServiceProject, input: ServicePinInput): Promise<ServicePin> {
    const pin: ServicePin = { id: newServiceId(input.name), ...input };
    await saveServices(project.dataDir, (file) => ({ ...file, services: [...file.services, pin] }));
    this.changed(project.id);
    return pin;
  }

  async patch(project: ServiceProject, id: string, patch: ServicePatch): Promise<ServiceResult<ServicePin>> {
    let found: ServicePin | null = null;
    await saveServices(project.dataDir, (file) => ({
      ...file,
      services: file.services.map((pin) => {
        if (pin.id !== id) return pin;
        found = { ...pin, ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) } as ServicePin;
        return found;
      }),
    }));
    if (!found) return refuse(404, 'no such service');
    this.changed(project.id);
    return { ok: true, value: found };
  }

  async unpin(project: ServiceProject, id: string): Promise<ServiceResult<null>> {
    if (this.state(project, id).status === 'running') return refuse(409, 'stop the service before removing it');
    let removed = false;
    await saveServices(project.dataDir, (file) => {
      removed = file.services.some((pin) => pin.id === id);
      return { services: file.services.filter((pin) => pin.id !== id), lastRunning: file.lastRunning.filter((other) => other !== id) };
    });
    if (!removed) return refuse(404, 'no such service');
    this.runtime.delete(this.key(project, id));
    this.urls.forget(this.key(project, id));
    this.changed(project.id);
    return { ok: true, value: null };
  }

  async start(project: ServiceProject, id: string): Promise<ServiceResult<null>> {
    const pin = (await loadServices(project.dataDir)).services.find((other) => other.id === id);
    if (!pin) return refuse(404, 'no such service');
    const state = this.state(project, id);
    if (state.status === 'running') return { ok: true, value: null };

    const cwd = pin.cwd === '' ? project.root : join(project.root, pin.cwd);
    const fail = (reason: string): ServiceResult<null> => {
      Object.assign(state, { status: 'exited', sessionId: null, exitCode: null, reason, startedAt: null, last: null });
      this.changed(project.id);
      return refuse(409, reason);
    };
    try {
      if (!(await lstat(cwd)).isDirectory()) return fail(`${pin.cwd || '.'} is not a directory`);
    } catch {
      return fail(`${pin.cwd || '.'} does not exist in this checkout`);
    }
    const owner = this.key(project, id);
    this.urls.forget(owner);
    const created = await this.sessions.create({ runId: owner, cwd, command: pin.command, label: pin.name, cols: 120, rows: 30, env: this.env() });
    if (!created.ok) return fail(created.reason);

    const sessionId = created.session.id;
    Object.assign(state, { status: 'running', sessionId, exitCode: null, reason: null, startedAt: created.session.startedAt, last: null });
    this.onSession(sessionId);
    state.release = this.sessions.subscribe(sessionId, () => {
      if (state.sessionId !== sessionId) return;
      const info = this.sessions.get(sessionId);
      // Gone without an exit code: the registry was closed under us (cezar shutting down). The
      // pins that were running stay in `lastRunning` — that is what Resume is for.
      if (info === null) return this.settle(project, state, 'stopped', null, false);
      if (info.exitCode !== null) this.settle(project, state, 'exited', info.exitCode, true);
    });
    await this.remember(project);
    this.changed(project.id);
    return { ok: true, value: null };
  }

  /** Leave `running`: keep the scrollback, drop the session, and say so. */
  private settle(project: ServiceProject, state: Runtime, status: 'stopped' | 'exited', exitCode: number | null, persist: boolean): void {
    if (state.status !== 'running') return;
    const read = state.sessionId ? this.sessions.read(state.sessionId, 0) : null;
    if (read) state.last = { data: read.data, end: read.cursor };
    state.release?.();
    Object.assign(state, { status, sessionId: null, exitCode, release: null });
    if (persist) void this.remember(project).catch(() => {});
    this.changed(project.id);
  }

  async stop(project: ServiceProject, id: string): Promise<ServiceResult<null>> {
    const state = this.runtime.get(this.key(project, id));
    if (!state || state.status !== 'running') {
      const known = (await loadServices(project.dataDir)).services.some((pin) => pin.id === id);
      return known ? { ok: true, value: null } : refuse(404, 'no such service');
    }
    const sessionId = state.sessionId;
    this.settle(project, state, 'stopped', null, false);
    if (sessionId) this.sessions.kill(sessionId);
    await this.remember(project);
    return { ok: true, value: null };
  }

  async restart(project: ServiceProject, id: string): Promise<ServiceResult<null>> {
    const stopped = await this.stop(project, id);
    return stopped.ok ? this.start(project, id) : stopped;
  }

  async startAll(project: ServiceProject, ids?: string[]): Promise<void> {
    const { services } = await loadServices(project.dataDir);
    for (const pin of services) if (!ids || ids.includes(pin.id)) await this.start(project, pin.id);
  }

  async stopAll(project: ServiceProject): Promise<void> {
    const { services } = await loadServices(project.dataDir);
    for (const pin of services) await this.stop(project, pin.id);
  }

  /** A project no route can reach any more: stop what it runs. Its pins are its repo's. */
  stopProject(projectId: string): void {
    const prefix = serviceTerminalOwner(projectId, '');
    for (const [key, state] of this.runtime) {
      if (!key.startsWith(prefix)) continue;
      const sessionId = state.sessionId;
      if (state.status === 'running') {
        state.release?.();
        Object.assign(state, { status: 'stopped', sessionId: null, release: null });
      }
      if (sessionId) this.sessions.kill(sessionId);
      this.runtime.delete(key);
    }
  }

  /** `lastRunning` is exactly the set running now, rewritten on every start and stop. */
  private async remember(project: ServiceProject): Promise<void> {
    await saveServices(project.dataDir, (file) => ({
      ...file,
      lastRunning: file.services.map((pin) => pin.id).filter((id) => this.runtime.get(this.key(project, id))?.status === 'running'),
    }));
  }

  /** Output since `cursor`: the live session's, or the last one's kept scrollback. */
  read(project: ServiceProject, id: string, cursor: number): TerminalRead | null {
    const state = this.runtime.get(this.key(project, id));
    if (!state) return { data: '', cursor: 0, truncated: false, exitCode: null };
    if (state.sessionId) return this.sessions.read(state.sessionId, cursor);
    if (!state.last) return { data: '', cursor: 0, truncated: false, exitCode: state.exitCode };
    const start = state.last.end - state.last.data.length;
    const from = Number.isFinite(cursor) ? Math.max(0, Math.min(Math.trunc(cursor), state.last.end)) : 0;
    return { data: state.last.data.slice(Math.max(0, from - start)), cursor: state.last.end, truncated: from < start, exitCode: state.exitCode };
  }

  write(project: ServiceProject, id: string, data: string): boolean {
    const sessionId = this.runtime.get(this.key(project, id))?.sessionId;
    return sessionId ? this.sessions.write(sessionId, data) : false;
  }

  resize(project: ServiceProject, id: string, cols: number, rows: number): boolean {
    const sessionId = this.runtime.get(this.key(project, id))?.sessionId;
    return sessionId ? this.sessions.resize(sessionId, cols, rows) : false;
  }

  /** The last `tail` lines as plain text — what an agent reads. */
  logs(project: ServiceProject, id: string, tail: number): string {
    const text = stripAnsi(this.read(project, id, 0)?.data ?? '');
    return text.split('\n').slice(-tail).join('\n');
  }

  status(project: ServiceProject, id: string): Pick<Runtime, 'status' | 'exitCode'> {
    const state = this.runtime.get(this.key(project, id));
    return { status: state?.status ?? 'stopped', exitCode: state?.exitCode ?? null };
  }
}

/** Escape sequences and carriage-return overwrites removed: a log a model can read. */
export function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[@-Z\\-_]/g, '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.slice(line.lastIndexOf('\r') + 1))
    .join('\n');
}
