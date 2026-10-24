import { execFile } from 'node:child_process';
import { basename } from 'node:path';
import type { DockerConflict, DockerContainer, DockerPort, DockerStack } from '@open-mercato/cezar-contract';
import { judgeDir, worktreeRunOf } from './docker-manage.ts';

/**
 * The machine's containers, read through the `docker` CLI (spec `2026-10-13-docker-view`).
 * Nothing here throws and nothing is stored: no docker, or no daemon, is an answer with a reason.
 */

export type DockerResult = { ok: true; stdout: string } | { ok: false; reason: string };
export type DockerExec = (args: string[], options?: { cwd?: string; timeoutMs?: number }) => Promise<DockerResult>;

const DAEMON_DOWN = /cannot connect to the docker daemon|failed to connect to the docker api|is the docker daemon running|error during connect/i;

export const dockerExec: DockerExec = (args, options = {}) =>
  new Promise((resolve) => {
    // Dry run stays off the host's tools, like every other CLI cezar shells out to.
    if (process.env.CEZ_DRY_RUN === '1') return resolve({ ok: false, reason: 'Docker is not read in a dry run' });
    execFile(
      'docker', args,
      { cwd: options.cwd, timeout: options.timeoutMs ?? 10_000, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8', windowsHide: true },
      (err, stdout, stderr) => {
        if (!err) return resolve({ ok: true, stdout });
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return resolve({ ok: false, reason: 'docker is not on PATH' });
        const line = stderr.split('\n').map((text) => text.trim()).find((text) => text !== '') ?? err.message;
        resolve({ ok: false, reason: DAEMON_DOWN.test(line) ? 'Docker is installed, but its daemon is not running' : line.slice(0, 300) });
      },
    );
  });

/** `0.0.0.0:5432->5432/tcp, [::]:5432->5432/tcp, 6379/tcp` → the published ones, once each. */
export function parseDockerPorts(text: string): DockerPort[] {
  const out = new Map<string, DockerPort>();
  for (const part of text.split(',')) {
    const match = /^(?:.*:)?(\d+)(?:-(\d+))?->(\d+)(?:-\d+)?\/(\w+)$/.exec(part.trim());
    if (!match) continue;
    const first = Number(match[1]);
    const last = Math.min(Number(match[2] ?? match[1]), first + 63);
    for (let host = first; host <= last; host += 1) {
      const port = { host, container: Number(match[3]) + (host - first), protocol: match[4]! };
      out.set(`${port.host}/${port.protocol}`, port);
    }
  }
  return [...out.values()].sort((a, b) => a.host - b.host);
}

export interface ListedContainer extends DockerContainer {
  stack: string;
  dir: string | null;
  /** Volume names (and bind sources) it mounts — who uses a volume (spec 2026-10-23-docker-management §3.3). */
  mounts: string[];
  /** The compose files it was started from (`project.config_files`), so `down` reads the same ones. */
  configFiles: string[];
}

const PS_FORMAT = [
  '{{.ID}}', '{{.Names}}', '{{.Image}}', '{{.State}}', '{{.Status}}', '{{.Ports}}',
  '{{.Label "com.docker.compose.project"}}', '{{.Label "com.docker.compose.service"}}',
  '{{.Label "com.docker.compose.project.working_dir"}}', '{{.Mounts}}', '{{.Label "com.docker.compose.project.config_files"}}',
].join('\t');

export async function listContainers(exec: DockerExec): Promise<{ ok: true; containers: ListedContainer[] } | { ok: false; reason: string }> {
  const result = await exec(['ps', '-a', '--no-trunc', '--format', PS_FORMAT]);
  if (!result.ok) return result;
  const containers: ListedContainer[] = [];
  for (const line of result.stdout.split('\n')) {
    const [id, name, image, state, status, ports, stack, service, dir, mounts, configFiles] = line.replace(/\r$/, '').split('\t');
    if (!id || !/^[a-f0-9]{12,64}$/.test(id)) continue;
    containers.push({
      id, name: name ?? '', image: image ?? '', running: state === 'running', status: status ?? '',
      ports: parseDockerPorts(ports ?? ''), service: service || null, stack: stack ?? '', dir: dir || null,
      mounts: (mounts ?? '').split(',').map((mount) => mount.trim()).filter(Boolean),
      configFiles: (configFiles ?? '').split(',').map((file) => file.trim()).filter(Boolean),
    });
  }
  return { ok: true, containers };
}

/** What changes when a container starts, stops or re-publishes — and not as its uptime ticks. */
export const containersSignature = (containers: ListedContainer[]): string =>
  containers.map((c) => `${c.id}:${c.running ? 1 : 0}:${c.ports.map((p) => p.host).join(',')}`).sort().join('|');

/** Comparable form of a host path: `/`-separated, no trailing slash, a drive letter folded. */
const comparable = (path: string): string => {
  const slashed = path.replace(/\\/g, '/').replace(/\/+$/, '');
  return /^[a-z]:/i.test(slashed) ? slashed.toLowerCase() : slashed;
};

export interface KnownProject { id: string; root: string; name: string }

/** The registered project `dir` is inside — the deepest root, so a nested checkout wins. */
export function projectOf(dir: string | null, projects: KnownProject[]): KnownProject | null {
  if (dir === null) return null;
  const target = comparable(dir);
  let best: KnownProject | null = null;
  for (const project of projects) {
    const root = comparable(project.root);
    if (target !== root && !target.startsWith(`${root}/`)) continue;
    if (!best || root.length > comparable(best.root).length) best = project;
  }
  return best;
}

/** What `groupStacks` learns from outside the listing (spec 2026-10-23-docker-management §3.1). */
export interface StackFacts {
  /** Whether a stack's working dir is still on disk; `judgeDir` by default. */
  dirState?: (dir: string | null) => DockerStack['dirState'];
  /** The cezar task whose worktree the dir is, given the project that owns it. */
  task?: (dir: string, owner: KnownProject) => DockerStack['task'];
  /** Volume names by compose project. */
  volumes?: Map<string, string[]>;
}

/** Stacks in a stable order: this project's first, then by name, loose containers last. */
export function groupStacks(containers: ListedContainer[], projects: KnownProject[], currentId: string, facts: StackFacts = {}): DockerStack[] {
  const members = new Map<string, ListedContainer[]>();
  for (const container of containers) members.set(container.stack, [...(members.get(container.stack) ?? []), container]);
  const stacks: DockerStack[] = [];
  for (const [name, list] of members) {
    // `mounts` and `configFiles` are the listing's own bookkeeping, not part of a container on the wire.
    const wire = list.map(({ stack: _stack, dir: _dir, mounts: _mounts, configFiles: _configFiles, ...container }) => container)
      .sort((a, b) => a.name.localeCompare(b.name));
    if (name === '') {
      stacks.push({ name, dir: null, project: null, mine: false, containers: wire, dirState: 'unknown', task: null, volumes: [] });
      continue;
    }
    // A project name compose shares across dirs (`name:` up from a checkout and a worktree) is judged by all of them:
    // gone only when every container's dir is, live while any is, and an active task anywhere in it protects it.
    const dirs = [...new Set(list.map((container) => container.dir))];
    const states = new Map(dirs.map((dir) => [dir, (facts.dirState ?? judgeDir)(dir)]));
    const all = [...states.values()];
    const dirState: DockerStack['dirState'] = all.includes('exists') ? 'exists' : all.every((state) => state === 'gone') ? 'gone' : 'unknown';
    // Shown by a live dir, else by one that is no task worktree — so "a gone task worktree's" holds for all of it.
    const dir = dirs.find((entry) => states.get(entry) === 'exists')
      ?? dirs.find((entry) => entry !== null && worktreeRunOf(entry) === null) ?? dirs.find((entry) => entry !== null) ?? null;
    const owner = projectOf(dir, projects);
    const taskOf = (entry: string | null): DockerStack['task'] => {
      const by = entry === null ? null : projectOf(entry, projects);
      return by && entry !== null ? facts.task?.(entry, by) ?? null : null;
    };
    const tasks = dirs.map(taskOf);
    stacks.push({
      name, dir,
      project: owner ? { id: owner.id, name: owner.name || basename(owner.root) } : null,
      mine: owner?.id === currentId, containers: wire, dirState,
      task: tasks.find((task) => task?.active === true) ?? taskOf(dir),
      volumes: facts.volumes?.get(name) ?? [],
    });
  }
  const rank = (stack: DockerStack): number => (stack.name === '' ? 2 : stack.mine ? 0 : 1);
  return stacks.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

export interface WantedPort { port: number; service: string; file: string }

/**
 * The host ports a compose file publishes, as compose itself resolves them (env interpolation,
 * `extends`, profiles). Needs no daemon. A file compose cannot resolve wants nothing we can name.
 */
export async function composeWantedPorts(exec: DockerExec, root: string, cwd: string, file: string): Promise<WantedPort[]> {
  const result = await exec(['compose', '-f', file, 'config', '--format', 'json'], { cwd: cwd === '' ? root : `${root}/${cwd}` });
  if (!result.ok) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return [];
  }
  const services = (parsed as { services?: unknown } | null)?.services;
  if (typeof services !== 'object' || services === null) return [];
  const out: WantedPort[] = [];
  for (const [service, body] of Object.entries(services as Record<string, { ports?: unknown } | null>)) {
    if (!Array.isArray(body?.ports)) continue;
    for (const entry of body.ports as Array<{ published?: unknown }>) {
      const port = Number(typeof entry?.published === 'string' ? entry.published.split('-')[0] : entry?.published);
      if (Number.isInteger(port) && port > 0) out.push({ port, service, file: cwd === '' ? file : `${cwd}/${file}` });
    }
  }
  return out;
}

/** The wanted ports a RUNNING container of somebody else's stack holds. */
export function portConflicts(wanted: WantedPort[], stacks: DockerStack[]): DockerConflict[] {
  const held = new Map<number, { stack: string; container: string }>();
  for (const stack of stacks) {
    if (stack.mine) continue;
    for (const container of stack.containers) {
      if (!container.running) continue;
      for (const port of container.ports) if (!held.has(port.host)) held.set(port.host, { stack: stack.name, container: container.name });
    }
  }
  const out = new Map<number, DockerConflict>();
  for (const want of wanted) {
    const holder = held.get(want.port);
    if (holder && !out.has(want.port)) out.set(want.port, { ...want, ...holder });
  }
  return [...out.values()].sort((a, b) => a.port - b.port);
}
