import { execFile } from 'node:child_process';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { AgentStateLocations } from '../paths.ts';
import type { TarSource } from './tar.ts';

/**
 * What goes into an archive (spec `2026-10-23-backup-restore.md` §3): `CEZ_HOME`, the agents' and
 * git's state, and each project's untracked allowlisted files. Never a repository, never a
 * worktree, never a dependency tree.
 */

export const MANIFEST_VERSION = 1;

export const backupManifestSchema = z.object({
  version: z.literal(MANIFEST_VERSION),
  createdAt: z.string(),
  cezarVersion: z.string(),
  host: z.string(),
  compression: z.enum(['zstd', 'gzip']),
  projects: z.array(
    z.object({
      id: z.string().regex(/^(?!\.{1,2}$)[A-Za-z0-9._-]{1,128}$/),
      root: z.string().min(1),
      remote: z.string().nullable(),
      branch: z.string().nullable(),
    }),
  ),
  sizes: z.object({
    data: z.number().int().min(0),
    agents: z.number().int().min(0),
    projects: z.number().int().min(0),
    files: z.number().int().min(0),
  }),
});
export type BackupManifest = z.infer<typeof backupManifestSchema>;

/** Top-level `CEZ_HOME` entries that are not state: archives themselves, cezar's own installed
 *  code, caches (`npm-cache` is the self-updater's fallback, `npmFallbackCache`) and staging.
 *  A restore never overwrites them either. */
const DATA_SKIP = new Set(['backups', 'versions', 'bin', 'current', 'cache', 'npm-cache', 'uploads', 'restore-marker.json', 'restore-marker.json.consumed', 'restore-journal.json']);

export function isSkippedDataEntry(name: string): boolean {
  return DATA_SKIP.has(name) || name.startsWith('.restore') || name.endsWith('.lock') || name.endsWith('.tmp');
}

/** The agents' state, as archive directory → where it lives on this machine. */
export function agentEntries(locations: AgentStateLocations): Array<{ archive: string; path: string; kind: 'dir' | 'file' }> {
  return [
    { archive: 'agents/claude', path: locations.claude, kind: 'dir' as const },
    ...(locations.claudeState ? [{ archive: 'agents/claude.json', path: locations.claudeState, kind: 'file' as const }] : []),
    { archive: 'agents/codex', path: locations.codex, kind: 'dir' as const },
    { archive: 'agents/gh', path: locations.gh, kind: 'dir' as const },
    { archive: 'agents/ssh', path: locations.ssh, kind: 'dir' as const },
    { archive: 'agents/gitconfig', path: locations.gitconfig, kind: 'file' as const },
  ];
}

/**
 * Whether an untracked project path is worth keeping: `.env` / `.env.*` anywhere, `.ai/cezar/**`
 * minus task worktrees, and a root `config.local.json`. Nothing under a dependency tree.
 */
export function projectFileQualifies(rel: string): boolean {
  if (rel === '' || rel.startsWith('/') || rel.split('/').some((part) => part === '..' || part === '')) return false;
  const parts = rel.split('/');
  if (parts.includes('node_modules') || parts.includes('.git')) return false;
  if (rel.startsWith('.ai/cezar/')) return !rel.startsWith('.ai/cezar/worktrees/');
  if (rel === 'config.local.json') return true;
  const name = parts[parts.length - 1]!;
  return name === '.env' || name.startsWith('.env.');
}

const PATHSPECS = [
  ':(glob)**/.env',
  ':(glob)**/.env.*',
  ':(glob).ai/cezar/**',
  'config.local.json',
  ':(exclude,glob).ai/cezar/worktrees/**',
  ':(exclude,glob)**/node_modules/**',
];

function git(cwd: string, args: string[]): Promise<{ ok: boolean; stdout: string }> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 120_000 }, (error, stdout) =>
      resolve({ ok: !error, stdout: stdout ?? '' }),
    );
  });
}

/**
 * A project's contribution, repo-relative. `git ls-files --others` WITHOUT `--exclude-standard`:
 * the files worth keeping — `.env`, run history under `.ai/cezar/` — are the ignored ones, so the
 * allowlist (as pathspecs, then re-checked) is what keeps build output out, not the ignore rules.
 */
export async function projectUntrackedFiles(root: string): Promise<string[]> {
  const result = await git(root, ['ls-files', '--others', '-z', '--', ...PATHSPECS]);
  if (!result.ok) return [];
  return [...new Set(result.stdout.split('\0').filter(Boolean))].filter(projectFileQualifies).sort();
}

export async function projectIdentity(root: string): Promise<{ remote: string | null; branch: string | null }> {
  const remote = await git(root, ['remote', 'get-url', 'origin']);
  let url = remote.ok ? remote.stdout.trim() : '';
  if (!url) {
    const names = await git(root, ['remote']);
    const first = names.stdout.split('\n').map((name) => name.trim()).find(Boolean);
    if (first) url = (await git(root, ['remote', 'get-url', first])).stdout.trim();
  }
  const branch = await git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const name = branch.ok ? branch.stdout.trim() : '';
  return { remote: url || null, branch: name && name !== 'HEAD' ? name : null };
}

/** Every regular file and directory under `dir`, archived under `prefix`. Symlinks are skipped. */
async function walk(
  dir: string,
  prefix: string,
  out: TarSource[],
  skipTop?: (name: string) => boolean,
): Promise<number> {
  let bytes = 0;
  const visit = async (abs: string, rel: string, top: boolean): Promise<void> => {
    let entries;
    try {
      entries = await readdir(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (top && skipTop?.(entry.name)) continue;
      if (entry.name === 'node_modules') continue;
      const childAbs = join(abs, entry.name);
      const childRel = `${rel}/${entry.name}`;
      let info;
      try {
        info = await lstat(childAbs);
      } catch {
        continue;
      }
      if (info.isDirectory()) {
        out.push({ name: childRel, type: 'dir', mode: info.mode & 0o7777, mtime: info.mtime, size: 0 });
        await visit(childAbs, childRel, false);
      } else if (info.isFile()) {
        out.push({ name: childRel, type: 'file', mode: info.mode & 0o7777, mtime: info.mtime, size: info.size, path: childAbs });
        bytes += info.size;
      }
    }
  };
  await visit(dir, prefix, true);
  return bytes;
}

async function fileSource(path: string, name: string): Promise<TarSource | null> {
  try {
    const info = await lstat(path);
    if (!info.isFile()) return null;
    return { name, type: 'file', mode: info.mode & 0o7777, mtime: info.mtime, size: info.size, path };
  } catch {
    return null;
  }
}

const LIVE_STATUSES = new Set(['queued', 'running', 'waiting']);

/**
 * A record's promises to wake itself later (run schema): the usage-limit resume deadline and the
 * monitoring wake timer with its sub-state. No timer travels with a backup, and `recover()` on the
 * restored host would keep a promise another host made (review 2026-10-24, round 4).
 */
const SCHEDULING_FIELDS = ['autoResumeAt', 'monitoringWakeAt', 'monitoringWakeCapReached', 'activity'] as const;

/** Archive-only mark on a row `settleLiveRuns` changed; the store's schema drops it on load. */
const SETTLED_BY = 'settledByBackup';

/** A row a backup settled, by its mark alone: the note outlives the settling on a restored host,
 *  where a later pin or archive must still win (round 5). Its stamps are made up. */
export function settledByBackup(row: Record<string, unknown>): boolean {
  return typeof row[SETTLED_BY] === 'string';
}

/**
 * Run rows as an archive may carry them: none still live, none still scheduled. No process travels
 * with a backup, and boot recovery on the restored host would re-queue, resume or re-arm such a row
 * (review 2026-10-24, rounds 3 and 4) — so a live row is `failed` with an `interrupted — ` note, as
 * a cold read shows it, and a scheduled one loses its schedule with a note saying so.
 */
export function settleLiveRuns(rows: unknown[], capturedBy: string, now: Date = new Date()): unknown[] {
  return rows.map((row) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
    const was = (row as { status?: unknown }).status;
    const live = typeof was === 'string' && LIVE_STATUSES.has(was);
    if (!live && !SCHEDULING_FIELDS.some((key) => (row as Record<string, unknown>)[key] !== undefined)) return row;
    const run = structuredClone(row) as Record<string, unknown>;
    run[SETTLED_BY] = capturedBy;
    if (live) {
      const askParked = was === 'waiting' && run.askParked === true;
      run.status = 'failed';
      run.error = `interrupted — captured by ${capturedBy} while it was ${was}`;
      if (typeof run.finishedAt !== 'string') run.finishedAt = now.toISOString();
      // Still the user's question to answer, as `reconcileLoadedRun` keeps it.
      if (askParked) run.awaitingAnswerSince = run.finishedAt;
      delete run.askParked;
    } else if (run.autoResumeAt !== undefined) {
      const note = `automatic resume cancelled — captured by ${capturedBy}; continue this task by hand`;
      run.error = typeof run.error === 'string' && run.error ? `${run.error}\n${note}` : note;
    }
    for (const key of SCHEDULING_FIELDS) delete run[key];
    if (Array.isArray(run.steps)) {
      run.steps = run.steps.map((step: unknown) =>
        step && typeof step === 'object' && ['running', 'waiting'].includes(String((step as { status?: unknown }).status))
          ? { ...(step as object), status: 'failed' }
          : step,
      );
    }
    return run;
  });
}

/** A project's run index for the archive: live rows settled, the live file untouched. */
async function runIndexSource(path: string, name: string, capturedBy: string, now: Date): Promise<TarSource | null> {
  const source = await fileSource(path, name);
  if (!source) return null;
  let rows: unknown;
  try {
    rows = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return source; // unreadable here too: carried as it is, and the restore keeps it aside
  }
  if (!Array.isArray(rows)) return source;
  const bytes = Buffer.from(JSON.stringify(settleLiveRuns(rows, capturedBy, now)), 'utf8');
  return { name, type: 'file', mode: source.mode, mtime: source.mtime, size: bytes.length, bytes };
}

/** `cezar-backup-<host>-…`: the machine's name as the archive pattern allows it. */
export function archiveHost(name: string = hostname()): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
  return slug || 'cezar';
}

/** Exactly one host's archive names — `web` does not match `web-2`'s (review 2026-10-24). */
export function hostArchivePattern(host: string): RegExp {
  const escaped = host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^cezar-backup-${escaped}-(\\d{8}T\\d{4}Z)(?:-(\\d{1,3}))?\\.tar\\.(?:zst|gz)\\.age$`);
}

const ARCHIVE_TAIL = /-(\d{8}T\d{4}Z)(?:-(\d{1,3}))?\.tar\.(?:zst|gz)\.age$/;

/**
 * Newest first: by the name's timestamp, then by its `-N` suffix as a number (`-10` is newer than
 * `-2`, and both newer than none). A name sorted as text gets that backwards (review 2026-10-24).
 */
export function newestArchiveFirst(a: string, b: string): number {
  const at = ARCHIVE_TAIL.exec(a);
  const bt = ARCHIVE_TAIL.exec(b);
  if (at && bt) {
    if (at[1] !== bt[1]) return at[1]! < bt[1]! ? 1 : -1;
    const an = Number(at[2] ?? 1);
    const bn = Number(bt[2] ?? 1);
    if (an !== bn) return bn - an;
  } else if (at || bt) {
    return at ? -1 : 1;
  }
  return a < b ? 1 : a > b ? -1 : 0;
}

/** `20261023T0412Z`. */
export function archiveStamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z').replace(/(T\d{4})\d{2}Z$/, '$1Z');
}

export interface CollectInput {
  cezarHome: string;
  locations: AgentStateLocations;
  projects: Array<{ id: string; root: string }>;
  cezarVersion: string;
  compression: 'zstd' | 'gzip';
  host: string;
  now: Date;
  /** Named in the note on a run the archive captured while it was live. */
  archiveName?: string;
  log?: (line: string) => void;
}

/** The archive's entries, manifest first, and the manifest itself. */
export async function collectBackup(input: CollectInput): Promise<{ manifest: BackupManifest; entries: TarSource[] }> {
  const log = input.log ?? (() => {});
  const data: TarSource[] = [{ name: 'data', type: 'dir', mode: 0o700, mtime: input.now, size: 0 }];
  const dataBytes = await walk(input.cezarHome, 'data', data, isSkippedDataEntry);
  log(`cezar state: ${data.filter((entry) => entry.type === 'file').length} files`);

  const agents: TarSource[] = [{ name: 'agents', type: 'dir', mode: 0o700, mtime: input.now, size: 0 }];
  let agentBytes = 0;
  for (const entry of agentEntries(input.locations)) {
    if (entry.kind === 'file') {
      const source = await fileSource(entry.path, entry.archive);
      if (source) {
        agents.push(source);
        agentBytes += source.size;
      }
      continue;
    }
    try {
      if (!(await lstat(entry.path)).isDirectory()) continue;
    } catch {
      continue;
    }
    agents.push({ name: entry.archive, type: 'dir', mode: 0o700, mtime: input.now, size: 0 });
    agentBytes += await walk(entry.path, entry.archive, agents);
  }
  log(`agent logins: ${agents.filter((entry) => entry.type === 'file').length} files`);

  const projects: TarSource[] = [{ name: 'projects', type: 'dir', mode: 0o700, mtime: input.now, size: 0 }];
  const manifestProjects: BackupManifest['projects'] = [];
  let projectBytes = 0;
  for (const project of input.projects) {
    const identity = await projectIdentity(project.root);
    manifestProjects.push({ id: project.id, root: project.root, ...identity });
    const files = await projectUntrackedFiles(project.root);
    projects.push({ name: `projects/${project.id}`, type: 'dir', mode: 0o700, mtime: input.now, size: 0 });
    let count = 0;
    for (const rel of files) {
      const at = join(project.root, ...rel.split('/'));
      const name = `projects/${project.id}/${rel}`;
      const source = rel === '.ai/cezar/runs.json'
        ? await runIndexSource(at, name, `backup ${input.archiveName ?? `from ${input.host}`}`, input.now)
        : await fileSource(at, name);
      if (!source) continue;
      projects.push(source);
      projectBytes += source.size;
      count += 1;
    }
    log(`project ${project.id}: ${count} files`);
  }

  const files = [...data, ...agents, ...projects].filter((entry) => entry.type === 'file').length;
  const manifest: BackupManifest = {
    version: MANIFEST_VERSION,
    createdAt: input.now.toISOString(),
    cezarVersion: input.cezarVersion,
    host: input.host,
    compression: input.compression,
    projects: manifestProjects,
    sizes: { data: dataBytes, agents: agentBytes, projects: projectBytes, files },
  };
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  const manifestEntry: TarSource = { name: 'manifest.json', type: 'file', mode: 0o600, mtime: input.now, size: bytes.length, bytes };
  return { manifest, entries: [manifestEntry, ...data, ...agents, ...projects] };
}
