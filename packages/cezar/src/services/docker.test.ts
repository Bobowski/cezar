import { describe, expect, it } from 'vitest';
import {
  composeWantedPorts, containersSignature, groupStacks, listContainers, parseDockerPorts, portConflicts, projectOf,
  type DockerExec,
} from './docker.ts';

const ID = (n: number) => String(n).repeat(12);
const row = (...cells: string[]) => cells.join('\t');
const PS = [
  row(ID(1), 'shop-a-postgres-1', 'postgres:16', 'running', 'Up 3 hours', '0.0.0.0:5432->5432/tcp, [::]:5432->5432/tcp', 'shop-a', 'postgres', '/srv/shop-a'),
  row(ID(2), 'shop-a-redis-1', 'redis:7', 'exited', 'Exited (0) 2 days ago', '', 'shop-a', 'redis', '/srv/shop-a'),
  row(ID(3), 'shop-b-postgres-1', 'postgres:16', 'running', 'Up 1 minute', '0.0.0.0:5433->5432/tcp, 6379/tcp', 'shop-b', 'postgres', '/srv/shop-b/.ai/cezar/worktrees/abc'),
  row(ID(4), 'adminer', 'adminer', 'running', 'Up 1 minute', '0.0.0.0:8080-8081->8080-8081/tcp', '', '', ''),
  'not a container line',
].join('\n');
const scripted = (answers: Record<string, string | null>): DockerExec => async (args) => {
  const out = answers[args[0]!];
  return out === null || out === undefined ? { ok: false, reason: 'docker is not on PATH' } : { ok: true, stdout: out };
};
const PROJECTS = [{ id: 'a', root: '/srv/shop-a', name: 'Shop A' }, { id: 'b', root: '/srv/shop-b', name: '' }];

describe('docker view (spec 2026-10-13-docker-view)', () => {
  it('reads published ports once each, expands a range, and ignores an unpublished one', () => {
    expect(parseDockerPorts('0.0.0.0:5432->5432/tcp, [::]:5432->5432/tcp, 6379/tcp')).toEqual([{ host: 5432, container: 5432, protocol: 'tcp' }]);
    expect(parseDockerPorts('0.0.0.0:8080-8081->80-81/tcp').map((p) => `${p.host}:${p.container}`)).toEqual(['8080:80', '8081:81']);
    expect(parseDockerPorts('')).toEqual([]);
  });

  it('groups containers by compose project and names the cezar project that owns each', async () => {
    const listed = await listContainers(scripted({ ps: PS }));
    if (!listed.ok) throw new Error(listed.reason);
    const stacks = groupStacks(listed.containers, PROJECTS, 'b');
    // This project's stack first, loose containers last.
    expect(stacks.map((s) => [s.name, s.mine, s.project?.name ?? null])).toEqual([
      ['shop-b', true, 'shop-b'], ['shop-a', false, 'Shop A'], ['', false, null],
    ]);
    expect(stacks[1]?.containers.map((c) => [c.service, c.running])).toEqual([['postgres', true], ['redis', false]]);
  });

  it('matches a stack to the deepest project root, across path spellings', () => {
    expect(projectOf('F:\\Code\\Shop\\backend', [{ id: 'x', root: 'f:/code/shop', name: '' }])?.id).toBe('x');
    expect(projectOf('/srv/shop-ab', PROJECTS)).toBeNull();
    expect(projectOf('/srv/shop-a/inner', [...PROJECTS, { id: 'in', root: '/srv/shop-a/inner', name: '' }])?.id).toBe('in');
    expect(projectOf(null, PROJECTS)).toBeNull();
  });

  it('reports a wanted port only when another stack is running on it', async () => {
    const exec = scripted({ ps: PS, compose: JSON.stringify({ services: { db: { ports: [{ published: '5432', target: 5432 }] }, cache: { ports: [{ published: 6379 }] }, api: {} } }) });
    const wanted = await composeWantedPorts(exec, '/srv/shop-b', 'infra', 'compose.yml');
    expect(wanted).toEqual([{ port: 5432, service: 'db', file: 'infra/compose.yml' }, { port: 6379, service: 'cache', file: 'infra/compose.yml' }]);
    const listed = await listContainers(exec);
    if (!listed.ok) throw new Error(listed.reason);
    expect(portConflicts(wanted, groupStacks(listed.containers, PROJECTS, 'b'))).toEqual([
      { port: 5432, service: 'db', file: 'infra/compose.yml', stack: 'shop-a', container: 'shop-a-postgres-1' },
    ]);
    // Seen from the project that holds the port, it is not a conflict.
    expect(portConflicts(wanted, groupStacks(listed.containers, PROJECTS, 'a'))).toEqual([]);
  });

  it('answers with a reason, never an exception, when docker or compose cannot be read', async () => {
    expect(await listContainers(scripted({ ps: null }))).toEqual({ ok: false, reason: 'docker is not on PATH' });
    expect(await composeWantedPorts(scripted({ compose: null }), '/r', '', 'compose.yml')).toEqual([]);
    expect(await composeWantedPorts(scripted({ compose: 'not json' }), '/r', '', 'compose.yml')).toEqual([]);
    expect(await listContainers(scripted({ ps: '' }))).toEqual({ ok: true, containers: [] });
  });

  it('changes its signature on a start or stop, not as uptime ticks', async () => {
    const read = async (text: string) => {
      const listed = await listContainers(scripted({ ps: text }));
      return listed.ok ? containersSignature(listed.containers) : '';
    };
    expect(await read(PS)).toBe(await read(PS.replace('Up 3 hours', 'Up 4 hours')));
    expect(await read(PS)).not.toBe(await read(PS.replace('redis:7\texited', 'redis:7\trunning')));
  });
});
