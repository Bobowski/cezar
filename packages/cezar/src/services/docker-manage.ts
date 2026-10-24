import { existsSync } from 'node:fs';
import {
  DOCKER_DISK_WARN_PCT,
  type DockerDataRoot, type DockerDisk, type DockerDiskEntry, type DockerDiskKind, type DockerImage, type DockerReclaimItem,
  type DockerStack, type DockerUser, type DockerVolume,
} from '@open-mercato/cezar-contract';
import type { DockerExec, ListedContainer } from './docker.ts';

/**
 * Docker management (spec `2026-10-23-docker-management`): images, volumes, disk usage and the
 * Reclaim planner, read from the `docker` CLI's `--format json` output (Docker 29). Parsers never
 * throw: a line Docker phrased differently is skipped, a size it did not give is `null`.
 */

const UNITS: Record<string, number> = {
  b: 1, kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12, pb: 1e15,
  kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4, pib: 1024 ** 5,
};

/** Docker's human sizes (`2.287GB`, `63B`, `1.03GB (45%)`, `12.3kB`) → bytes; `null` for `N/A`. */
export function parseHumanSize(text: unknown): number | null {
  if (typeof text !== 'string') return null;
  const match = /^\s*([\d.]+)\s*([kmgtp]?i?b)\b/i.exec(text);
  if (!match) return null;
  const unit = UNITS[match[2]!.toLowerCase()];
  const value = Number(match[1]);
  return unit === undefined || !Number.isFinite(value) ? null : Math.round(value * unit);
}

/** `--format json` prints one object per line; `system df -v` prints one object in all. */
export function parseJsonLines(stdout: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const line of stdout.split('\n')) {
    const text = line.trim();
    if (!text.startsWith('{')) continue;
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) out.push(parsed as Record<string, unknown>);
    } catch {
      // A line Docker phrased differently is skipped, never fatal.
    }
  }
  return out;
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '');
const count = (value: unknown): number => {
  const parsed = Number.parseInt(str(value), 10);
  return Number.isFinite(parsed) ? parsed : 0;
};
/** `sha256:abc…` → `abc…`. */
export const hexId = (id: string): string => id.replace(/^sha256:/, '').toLowerCase();

/** `com.docker.compose.project=ffp,com.docker.compose.volume=pg` → a map. */
export function parseLabels(text: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of str(text).split(',')) {
    const at = pair.indexOf('=');
    if (at > 0) out[pair.slice(0, at).trim()] = pair.slice(at + 1).trim();
  }
  return out;
}

export interface ImageRow { id: string; tags: string[]; sizeBytes: number; created: string; dangling: boolean }

/** `docker image ls --no-trunc --format json`: one row per repo:tag, folded into one per image. */
export function parseImageList(stdout: string): ImageRow[] {
  const images = new Map<string, ImageRow>();
  for (const row of parseJsonLines(stdout)) {
    const id = hexId(str(row.ID));
    if (!/^[a-f0-9]{12,64}$/.test(id)) continue;
    const repository = str(row.Repository);
    const tag = str(row.Tag);
    let entry = images.get(id);
    if (!entry) {
      entry = { id, tags: [], sizeBytes: parseHumanSize(row.Size) ?? 0, created: str(row.CreatedAt), dangling: true };
      images.set(id, entry);
    }
    if (repository && repository !== '<none>') {
      entry.dangling = false;
      const name = tag && tag !== '<none>' ? `${repository}:${tag}` : repository;
      if (!entry.tags.includes(name)) entry.tags.push(name);
    }
  }
  return [...images.values()];
}

export interface VolumeRow { name: string; driver: string; labels: Record<string, string> }

/** `docker volume ls --format json`. */
export function parseVolumeList(stdout: string): VolumeRow[] {
  return parseJsonLines(stdout)
    .map((row) => ({ name: str(row.Name), driver: str(row.Driver), labels: parseLabels(row.Labels) }))
    .filter((row) => row.name !== '');
}

const DF_KINDS: Record<string, DockerDiskKind> = {
  images: 'images', containers: 'containers', 'local volumes': 'volumes', volumes: 'volumes', 'build cache': 'build-cache',
};

/** `docker system df --format json`: one line per kind. */
export function parseSystemDf(stdout: string): DockerDiskEntry[] {
  const entries: DockerDiskEntry[] = [];
  for (const row of parseJsonLines(stdout)) {
    const kind = DF_KINDS[str(row.Type).toLowerCase()];
    if (!kind || entries.some((entry) => entry.kind === kind)) continue;
    entries.push({
      kind, count: count(row.TotalCount), active: count(row.Active),
      totalBytes: parseHumanSize(row.Size) ?? 0, reclaimableBytes: parseHumanSize(row.Reclaimable) ?? 0,
    });
  }
  const order: DockerDiskKind[] = ['images', 'containers', 'volumes', 'build-cache'];
  return entries.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
}

/** `docker system df -v --format json`: the sizes the plain listings do not carry. */
export function parseSystemDfVerbose(stdout: string): { volumes: Map<string, number>; containers: Map<string, number> } {
  const volumes = new Map<string, number>();
  const containers = new Map<string, number>();
  for (const row of parseJsonLines(stdout)) {
    for (const volume of Array.isArray(row.Volumes) ? row.Volumes as Array<Record<string, unknown>> : []) {
      const size = parseHumanSize(volume?.Size);
      if (str(volume?.Name) && size !== null) volumes.set(str(volume.Name), size);
    }
    for (const container of Array.isArray(row.Containers) ? row.Containers as Array<Record<string, unknown>> : []) {
      const size = parseHumanSize(container?.Size);
      if (str(container?.ID) && size !== null) containers.set(hexId(str(container.ID)), size);
    }
  }
  return { volumes, containers };
}

/** `Total reclaimed space: 1.2GB` (prune) or `Total:\t1.2GB` (builder prune) → bytes. */
export function parseReclaimed(stdout: string): number {
  const match = /Total(?: reclaimed space)?:\s*([\d.]+\s*[kmgtp]?i?b)/i.exec(stdout);
  return match ? parseHumanSize(match[1]) ?? 0 : 0;
}

/**
 * Whether a stack's working dir is still there. A path in the other OS's spelling (a WSL path
 * seen from Windows) cannot be judged here, and an unjudged dir is never called gone — Reclaim
 * deletes volumes on that word.
 */
export function judgeDir(dir: string | null, platform: NodeJS.Platform = process.platform, exists: (path: string) => boolean = existsSync): 'exists' | 'gone' | 'unknown' {
  if (!dir) return 'unknown';
  const native = platform === 'win32' ? /^(?:[a-z]:[\\/]|\\\\)/i.test(dir) : dir.startsWith('/');
  if (!native) return 'unknown';
  return exists(dir) ? 'exists' : 'gone';
}

/** The run id when `dir` is (inside) a cezar task worktree: `<root>/.ai/cezar/worktrees/<runId>`. */
export function worktreeRunOf(dir: string | null): string | null {
  if (!dir) return null;
  const match = /\/\.ai\/cezar\/worktrees\/([^/]+)(?:\/|$)/.exec(dir.replace(/\\/g, '/'));
  return match ? match[1]! : null;
}

/** A listed container plus what only `container inspect` knows: the image it runs, by digest. */
export interface ManagedContainer extends ListedContainer { imageId: string | null }

const userOf = (container: ListedContainer): DockerUser => ({ id: container.id, name: container.name, running: container.running });

/** Images with who uses them; in-use first, then dangling last, then by name. */
export function buildImages(rows: ImageRow[], containers: ManagedContainer[]): DockerImage[] {
  const images = rows.map((row) => ({
    ...row,
    usedBy: containers.filter((container) => container.imageId !== null && (container.imageId.startsWith(row.id) || row.id.startsWith(container.imageId))).map(userOf),
  }));
  const rank = (image: DockerImage) => (image.usedBy.length > 0 ? 0 : image.dangling ? 2 : 1);
  return images.sort((a, b) => rank(a) - rank(b) || (a.tags[0] ?? a.id).localeCompare(b.tags[0] ?? b.id));
}

/**
 * Volumes with their stack, its owner and who mounts them; this project's first. A volume carries
 * no working dir, so its owner is its stack's — resolved by `groupStacks` through `projectOf`.
 */
export function buildVolumes(rows: VolumeRow[], sizes: Map<string, number>, containers: ListedContainer[], stacks: DockerStack[]): DockerVolume[] {
  const volumes = rows.map((row): DockerVolume => {
    const stack = row.labels['com.docker.compose.project'] || null;
    const known = stack === null ? undefined : stacks.find((entry) => entry.name === stack);
    return {
      name: row.name, driver: row.driver, sizeBytes: sizes.get(row.name) ?? null, stack,
      project: known?.project ?? null, mine: known?.mine ?? false,
      usedBy: containers.filter((container) => container.mounts.includes(row.name)).map(userOf),
    };
  });
  const rank = (volume: DockerVolume) => (volume.mine ? 0 : volume.stack !== null ? 1 : 2);
  return volumes.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

/** The volumes each compose project's labels name. */
export function volumesByStack(rows: VolumeRow[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const row of rows) {
    const stack = row.labels['com.docker.compose.project'];
    if (!stack) continue;
    out.set(stack, [...(out.get(stack) ?? []), row.name].sort());
  }
  return out;
}

export interface ReclaimInput {
  stacks: DockerStack[];
  images: DockerImage[];
  buildCacheBytes: number;
  volumeSizes: Map<string, number>;
  containerSizes: Map<string, number>;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * What Reclaim may free (spec §3.6), line by line: dangling images, build cache, task-worktree stacks whose
 * compose working dir is gone (their stopped containers go with them). A stopped container is never
 * proposed on its image alone: a `docker run` of the same image is someone else's.
 * Never a volume of a stack whose dir exists, an image in use, or anything of an active task.
 */
export function planReclaim(input: ReclaimInput): DockerReclaimItem[] {
  const items: DockerReclaimItem[] = [];
  const dangling = input.images.filter((image) => image.dangling && image.usedBy.length === 0);
  if (dangling.length > 0) {
    items.push({
      step: { kind: 'dangling-images' }, label: plural(dangling.length, 'dangling image'), detail: null,
      bytes: dangling.reduce((sum, image) => sum + image.sizeBytes, 0),
    });
  }
  if (input.buildCacheBytes > 0) items.push({ step: { kind: 'build-cache' }, label: 'Build cache', detail: null, bytes: input.buildCacheBytes });

  // Only a task worktree's stack (spec §2): a project checkout whose dir is gone is not Reclaim's to judge.
  const gone = input.stacks.filter((stack) => stack.name !== '' && stack.dirState === 'gone' && worktreeRunOf(stack.dir) !== null && stack.task?.active !== true);
  for (const stack of gone) {
    const containerBytes = stack.containers.reduce((sum, container) => sum + (input.containerSizes.get(container.id) ?? 0), 0);
    const volumeBytes = stack.volumes.reduce((sum, name) => sum + (input.volumeSizes.get(name) ?? 0), 0);
    items.push({
      step: { kind: 'stack', name: stack.name },
      label: `Stack ${stack.name} — ${stack.dir ?? 'no working dir'} is gone`,
      detail: [plural(stack.containers.length, 'container'), stack.volumes.length > 0 ? `volumes ${stack.volumes.join(', ')}` : null].filter(Boolean).join(' · '),
      bytes: containerBytes + volumeBytes,
    });
  }

  return items;
}

/** `container inspect` of every listed container at once: which image digest each one runs. */
export async function withImageIds(exec: DockerExec, containers: ListedContainer[]): Promise<ManagedContainer[]> {
  const ids = new Map<string, string>();
  if (containers.length > 0) {
    const result = await exec(['container', 'inspect', '--format', '{{.Id}}\t{{.Image}}', ...containers.map((c) => c.id)]);
    // A container removed between the two reads fails the whole inspect; the others stay unknown then.
    if (result.ok) {
      for (const line of result.stdout.split('\n')) {
        const [id, image] = line.trim().split('\t');
        if (id && image) ids.set(hexId(id), hexId(image));
      }
    }
  }
  return containers.map((container) => ({ ...container, imageId: ids.get(container.id) ?? null }));
}

export type StatFs = (path: string) => Promise<{ bsize: number; blocks: number; bavail: number }>;

/**
 * The daemon's data root, measured only when it is on this host's filesystem (spec §3.6) — in the
 * VPS image the daemon runs beside cezar; Docker Desktop keeps it in a VM, where `statfs` fails.
 */
export async function readDataRoot(exec: DockerExec, statfs: StatFs): Promise<DockerDataRoot | null> {
  const info = await exec(['info', '--format', '{{.DockerRootDir}}']);
  const path = info.ok ? info.stdout.trim() : '';
  if (!path) return null;
  try {
    const stats = await statfs(path);
    const sizeBytes = stats.blocks * stats.bsize;
    const freeBytes = stats.bavail * stats.bsize;
    if (sizeBytes <= 0) return null;
    return { path, sizeBytes, freeBytes, usedPct: Math.round(((sizeBytes - freeBytes) / sizeBytes) * 1000) / 10 };
  } catch {
    return null;
  }
}

/** `GET /docker/disk` minus the policy: `system df` and the data root. */
export async function readDisk(exec: DockerExec, statfs: StatFs): Promise<DockerDisk> {
  const df = await exec(['system', 'df', '--format', 'json'], { timeoutMs: 30_000 });
  if (!df.ok) return { available: false, reason: df.reason, entries: [], totalBytes: 0, reclaimableBytes: 0, dataRoot: null, warning: false };
  const entries = parseSystemDf(df.stdout);
  const dataRoot = await readDataRoot(exec, statfs);
  return {
    available: true, reason: null, entries,
    totalBytes: entries.reduce((sum, entry) => sum + entry.totalBytes, 0),
    reclaimableBytes: entries.reduce((sum, entry) => sum + entry.reclaimableBytes, 0),
    dataRoot, warning: dataRoot !== null && dataRoot.usedPct > DOCKER_DISK_WARN_PCT,
  };
}

/** The step a plan item stands for, as one comparable string. */
export const stepKey = (step: DockerReclaimItem['step']): string =>
  step.kind === 'stack' ? `stack:${step.name}` : step.kind === 'container' ? `container:${step.id}` : step.kind;
