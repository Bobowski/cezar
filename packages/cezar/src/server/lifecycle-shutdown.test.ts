import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { RunManager } from '../workflows/run.ts';
import { ProjectContexts } from './project-context.ts';
import { startServer } from './server.ts';
import { TerminalHistory } from './terminal/history.ts';

// Exercise shutdown orchestration without depending on host socket permissions.
vi.mock('@hono/node-server', async () => {
  const {createServer} = await import('node:http');
  return {serve: () => createServer()};
});

it('server shutdown drains boot and lazy lifecycle coordinators before disposing managers', async () => {
  vi.stubEnv('CEZ_AUTOMATIONS', '0');
  vi.stubEnv('CEZ_SKILLS_AUTO_UPDATE', '0');
  const root = await mkdtemp(join(tmpdir(), 'cez-server-shutdown-'));
  const store = RunStore.open(join(root, '.ai/cezar'));
  const manager = new RunManager(store, root);
  const contexts = new ProjectContexts({listProjects: async () => []});
  let finishBoot!: () => void;
  let finishLazy!: () => void;
  const boot = vi.spyOn(manager.lifecycle, 'shutdown').mockImplementation(() => new Promise<void>(resolve => { finishBoot = resolve; }));
  const lazy = vi.spyOn(contexts, 'shutdownAll').mockImplementation(() => new Promise<void>(resolve => { finishLazy = resolve; }));
  const dispose = vi.spyOn(manager, 'dispose');
  const server = startServer({repoRoot: root, store, manager, contexts, version: '0.0.0-test'}, 0);
  try {
    const stopping = server.shutdownLifecycle();
    expect(server.shutdownLifecycle()).toBe(stopping);
    expect(boot).toHaveBeenCalledOnce();
    expect(lazy).toHaveBeenCalledOnce();
    expect(dispose).not.toHaveBeenCalled();
    finishBoot();
    await Promise.resolve();
    expect(dispose).not.toHaveBeenCalled();
    finishLazy();
    await stopping;
    expect(dispose).toHaveBeenCalledOnce();
  } finally {
    finishBoot?.(); finishLazy?.();
    await server.shutdownLifecycle();
    vi.restoreAllMocks(); vi.unstubAllEnvs();
    await rm(root, {recursive: true, force: true});
  }
});

it('server shutdown waits for the terminal history to write what was typed (spec 2026-10-24-code-page-terminal §9)', async () => {
  vi.stubEnv('CEZ_AUTOMATIONS', '0');
  vi.stubEnv('CEZ_SKILLS_AUTO_UPDATE', '0');
  const root = await mkdtemp(join(tmpdir(), 'cez-server-shutdown-'));
  const store = RunStore.open(join(root, '.ai/cezar'));
  const manager = new RunManager(store, root);
  const terminalHistory = new TerminalHistory();
  let finishFlush!: () => void;
  const flushed = vi.spyOn(terminalHistory, 'flushed').mockImplementation(() => new Promise<void>(resolve => { finishFlush = resolve; }));
  const dispose = vi.spyOn(manager, 'dispose');
  const server = startServer({repoRoot: root, store, manager, terminalHistory, version: '0.0.0-test'}, 0);
  try {
    const stopping = server.shutdownLifecycle();
    expect(flushed).toHaveBeenCalledOnce();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(dispose).not.toHaveBeenCalled();
    finishFlush();
    await stopping;
    expect(dispose).toHaveBeenCalledOnce();
  } finally {
    finishFlush?.();
    await server.shutdownLifecycle();
    vi.restoreAllMocks(); vi.unstubAllEnvs();
    await rm(root, {recursive: true, force: true});
  }
});
