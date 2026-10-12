import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DetectedUrls } from '../server/terminal/detected-urls.ts';
import { TerminalSessions } from '../server/terminal/sessions.ts';
import { ProjectServices, stripAnsi, type ServiceProject } from './manager.ts';
import { loadServices } from './store.ts';
import { fakeServiceBinding } from './testkit.ts';

let root: string;
let project: ServiceProject;
let sessions: TerminalSessions;
let services: ProjectServices;
let spawned: ReturnType<typeof fakeServiceBinding>['spawned'];
let changes: string[];
let failure: string | null;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cez-services-'));
  mkdirSync(join(root, 'api'));
  project = { id: 'p1', root, dataDir: join(root, '.ai/cezar') };
  failure = null;
  const fake = fakeServiceBinding({ fail: () => failure });
  spawned = fake.spawned;
  sessions = new TerminalSessions(fake.binding, undefined, () => null);
  changes = [];
  services = new ProjectServices(sessions, new DetectedUrls(), (id) => changes.push(id), () => ({ CEZ_TASK_SLOT: '' }));
});
afterEach(() => {
  sessions.dispose();
  rmSync(root, { recursive: true, force: true });
});

const pinApi = () => services.pin(project, { name: 'api', command: 'yarn run dev', cwd: 'api' });
const statusOf = async (id: string) => (await services.list(project)).services.find((s) => s.id === id);
const lastRunning = () => JSON.parse(readFileSync(join(project.dataDir, 'services.json'), 'utf8')).lastRunning;

describe('project services (spec 2026-10-11-project-services §3.4)', () => {
  it('pins a command into services.json and lists it stopped', async () => {
    const pin = await pinApi();
    expect(pin.id).toMatch(/^api-[0-9a-f]{4}$/);
    expect(await statusOf(pin.id)).toMatchObject({ name: 'api', status: 'stopped', exitCode: null, topic: null });
    expect((await loadServices(project.dataDir)).services).toEqual([pin]);
  });

  it('start: runs the pinned command in its directory, as one command, with the slot keys', async () => {
    const pin = await pinApi();
    expect(await services.start(project, pin.id)).toEqual({ ok: true, value: null });
    expect(spawned).toHaveLength(1);
    expect(spawned[0]?.args.at(-1)).toBe('yarn run dev');
    expect(spawned[0]?.options).toMatchObject({ cwd: join(root, 'api') });
    expect(spawned[0]?.options.env.CEZ_TASK_SLOT).toBe('');
    expect(await statusOf(pin.id)).toMatchObject({ status: 'running' });
    expect(lastRunning()).toEqual([pin.id]);
    // Starting what runs is a no-op, never a second process.
    await services.start(project, pin.id);
    expect(spawned).toHaveLength(1);
  });

  it('start failing: exited, with the one-line reason', async () => {
    const pin = await pinApi();
    failure = 'ENOENT: no such shell';
    expect(await services.start(project, pin.id)).toMatchObject({ ok: false, status: 409 });
    expect(await statusOf(pin.id)).toMatchObject({ status: 'exited', reason: 'ENOENT: no such shell' });
    const gone = await services.pin(project, { name: 'gone', command: 'x', cwd: 'missing' });
    failure = null;
    expect(await services.start(project, gone.id)).toMatchObject({ ok: false, error: 'missing does not exist in this checkout' });
  });

  it('the process ending on its own: exited with its code, output kept, nothing restarted', async () => {
    const pin = await pinApi();
    await services.start(project, pin.id);
    spawned[0]?.emit('listening\r\ncrashed\r\n');
    spawned[0]?.finish(3);
    expect(await statusOf(pin.id)).toMatchObject({ status: 'exited', exitCode: 3 });
    expect(services.read(project, pin.id, 0)).toMatchObject({ data: 'listening\r\ncrashed\r\n', exitCode: 3 });
    expect(services.logs(project, pin.id, 1)).toBe('');
    expect(services.logs(project, pin.id, 2)).toBe('crashed\n');
    expect(spawned).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(lastRunning()).toEqual([]);
  });

  it('stop: kills the session, keeps the output, forgets it was running', async () => {
    const pin = await pinApi();
    await services.start(project, pin.id);
    spawned[0]?.emit('up\r\n');
    await services.stop(project, pin.id);
    expect(sessions.listFor('service:p1:' + pin.id)).toEqual([]);
    expect(await statusOf(pin.id)).toMatchObject({ status: 'stopped', exitCode: null });
    expect(services.read(project, pin.id, 0)?.data).toBe('up\r\n');
    expect(lastRunning()).toEqual([]);
  });

  it('restart: one stop, one fresh process', async () => {
    const pin = await pinApi();
    await services.start(project, pin.id);
    await services.restart(project, pin.id);
    expect(spawned).toHaveLength(2);
    expect(await statusOf(pin.id)).toMatchObject({ status: 'running' });
  });

  it('cezar shutting down: services stop, and stay offered for Resume', async () => {
    const pin = await pinApi();
    await services.start(project, pin.id);
    sessions.closeAll();
    const listed = await services.list(project);
    expect(listed.services[0]).toMatchObject({ status: 'stopped' });
    expect(listed.lastRunning).toEqual([pin.id]);
    // Resuming starts exactly those, and the offer is gone once something runs.
    await services.startAll(project, listed.lastRunning);
    expect((await services.list(project)).lastRunning).toEqual([]);
  });

  it('refuses to remove a running service, and removes a stopped one', async () => {
    const pin = await pinApi();
    await services.start(project, pin.id);
    expect(await services.unpin(project, pin.id)).toMatchObject({ ok: false, status: 409 });
    await services.stop(project, pin.id);
    expect(await services.unpin(project, pin.id)).toEqual({ ok: true, value: null });
    expect(await services.unpin(project, pin.id)).toMatchObject({ ok: false, status: 404 });
  });

  it('a removed project: its services stop, another project\'s keep running', async () => {
    const pin = await pinApi();
    const other: ServiceProject = { ...project, id: 'p2', dataDir: join(root, 'other') };
    const otherPin = await services.pin(other, { name: 'api', command: 'x', cwd: '' });
    await services.start(project, pin.id);
    await services.start(other, otherPin.id);
    services.stopProject('p1');
    expect(sessions.listFor('service:p1:' + pin.id)).toEqual([]);
    expect(sessions.listFor('service:p2:' + otherPin.id)).toHaveLength(1);
  });

  it('types into a running service and into nothing else', async () => {
    const pin = await pinApi();
    expect(services.write(project, pin.id, 'r')).toBe(false);
    await services.start(project, pin.id);
    expect(services.write(project, pin.id, 'r')).toBe(true);
    expect(spawned[0]?.written).toEqual(['r']);
  });

  it('announces every state change with the project it happened in', async () => {
    const pin = await pinApi();
    await services.start(project, pin.id);
    spawned[0]?.finish(0);
    expect(changes).toEqual(['p1', 'p1', 'p1']);
  });

  it('salvages good pins from a file with a bad row, and reads a corrupt file as empty', async () => {
    mkdirSync(project.dataDir, { recursive: true });
    writeFileSync(join(project.dataDir, 'services.json'), JSON.stringify({ services: [{ id: 'a', name: 'a', command: 'x', cwd: '' }, { id: 7 }], lastRunning: ['a', 'zz'] }));
    expect(await loadServices(project.dataDir)).toEqual({ services: [{ id: 'a', name: 'a', command: 'x', cwd: '' }], lastRunning: ['a'] });
    writeFileSync(join(project.dataDir, 'services.json'), '{ nope');
    expect(await loadServices(project.dataDir)).toEqual({ services: [], lastRunning: [] });
  });

  it('strips escape sequences and carriage-return overwrites from a log', () => {
    expect(stripAnsi('\x1b[32mok\x1b[0m\r\n10%\r50%\r100%\r\n\x1b]0;title\x07done')).toBe('ok\n100%\ndone');
  });
});
