import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { constants, createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { chmod, copyFile, lstat, open, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { Writable } from 'node:stream';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { cezarHomeDir, expandTilde, isAbsolutePath, restoreJournalPath, type AgentStateLocations } from '../paths.ts';
import { loadWorkspaceConfig } from '../workspace/config.ts';
import { decompressed, decrypted } from './codec.ts';
import { agentEntries, backupManifestSchema, isSkippedDataEntry, projectFileQualifies, settledByBackup, settleLiveRuns, type BackupManifest } from './collect.ts';
import { readTar } from './tar.ts';

/**
 * Restore (spec `2026-10-23-backup-restore.md` §4): decrypt and unpack into a staging dir under
 * `CEZ_HOME` — never a shared `/tmp` — verify the manifest, and only then put each part in place.
 * A file in the archive replaces the one on disk; a file the archive does not carry is left alone.
 */

const TOP = new Set(['manifest.json', 'data', 'agents', 'projects']);

/** An archive path that stays inside the staging dir, or null. */
export function safeArchivePath(name: string): string | null {
  if (name === '' || name.includes('\\') || name.includes('\0') || name.startsWith('/') || /^[A-Za-z]:/.test(name)) return null;
  const parts = name.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) return null;
  return TOP.has(parts[0]!) ? name : null;
}

const MANIFEST_MAX = 1024 * 1024;
/** What an archive may stage beyond its manifest's own totals before it is refused as lying. */
const STAGE_MARGIN = 1.1;

function parseManifest(bytes: Buffer): BackupManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error('the archive has no readable manifest — it is not a cezar backup');
  }
  const parsed = backupManifestSchema.safeParse(raw);
  if (!parsed.success) throw new Error('the archive manifest is not one this cezar understands');
  return parsed.data;
}

/** The manifest entry, held in memory (capped) and parsed the moment it ends. */
function manifestSink(onManifest: (manifest: BackupManifest) => void): Writable {
  const chunks: Buffer[] = [];
  let size = 0;
  return new Writable({
    write(chunk: Buffer, _encoding, callback) {
      size += chunk.length;
      if (size > MANIFEST_MAX) return callback(new Error('the archive manifest is implausibly large'));
      chunks.push(chunk);
      callback();
    },
    final(callback) {
      try {
        onManifest(parseManifest(Buffer.concat(chunks)));
        callback();
      } catch (error) {
        callback(error as Error);
      }
    },
  });
}

/**
 * Decrypt + decompress + untar `archive` into `staging`, then answer its manifest. The manifest
 * comes first (it is how cezar writes one) and bounds the rest: an archive that stages more
 * than it declares, by more than 10 %, is refused before it fills the disk.
 */
export async function stageArchive(archive: string, identity: string, staging: string): Promise<BackupManifest> {
  mkdirSync(staging, { recursive: true, mode: 0o700 });
  const plain = await decrypted(createReadStream(archive), identity);
  const tar = await decompressed(plain);
  let manifest: BackupManifest | undefined;
  let budget = { bytes: 0, files: 0 };
  await readTar(tar, (entry) => {
    const rel = safeArchivePath(entry.name);
    if (!rel) throw new Error(`the archive holds a path outside its own layout (${entry.name.slice(0, 120)})`);
    if (!manifest) {
      if (rel !== 'manifest.json' || entry.type !== 'file') throw new Error('the archive does not carry its manifest first — it is not a cezar backup');
      return manifestSink((parsed) => {
        manifest = parsed;
        const { data, agents, projects, files } = parsed.sizes;
        budget = { bytes: Math.ceil((data + agents + projects) * STAGE_MARGIN), files: Math.ceil(files * STAGE_MARGIN) };
      });
    }
    if (rel === 'manifest.json') throw new Error('the archive carries a second manifest');
    const abs = join(staging, ...rel.split('/'));
    if (entry.type === 'dir') {
      mkdirSync(abs, { recursive: true, mode: 0o700 });
      return null;
    }
    if (entry.type !== 'file') return null;
    budget.bytes -= entry.size;
    budget.files -= 1;
    if (budget.bytes < 0 || budget.files < 0) throw new Error('the archive holds more than its manifest says it does — refusing to unpack it');
    mkdirSync(dirname(abs), { recursive: true, mode: 0o700 });
    return createWriteStream(abs, { mode: entry.mode & 0o777 || 0o600 });
  });
  if (!manifest) throw new Error('the archive has no readable manifest — it is not a cezar backup');
  return manifest;
}

const kind = async (path: string): Promise<'missing' | 'dir' | 'file' | 'other'> => {
  try {
    const info = await lstat(path);
    return info.isDirectory() ? 'dir' : info.isFile() ? 'file' : 'other';
  } catch {
    return 'missing';
  }
};

/**
 * Across filesystems: copy to a fresh sibling and rename THAT over `dest`, so a link at `dest`
 * is replaced like `rename` replaces it, never followed. The sibling is created exclusively
 * (`COPYFILE_EXCL` never opens an existing path) and chmodded through a no-follow handle.
 */
async function copyAcross(src: string, dest: string, mode: number): Promise<void> {
  const tmp = join(dirname(dest), `.${basename(dest)}.cezar-restore-${randomBytes(6).toString('hex')}`);
  try {
    await copyFile(src, tmp, constants.COPYFILE_EXCL);
    const handle = await open(tmp, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      await handle.chmod(mode).catch(() => {});
    } finally {
      await handle.close();
    }
    await rename(tmp, dest);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
}

/** Move `src` over `dest`, across filesystems when it has to. A directory at `dest` is never removed. */
export async function placeFile(
  src: string,
  dest: string,
  mode: number,
  warn: (line: string) => void,
  move: (from: string, to: string) => Promise<void> = rename,
): Promise<boolean> {
  if ((await kind(dest)) === 'dir') {
    warn(`kept ${dest}: the archive has a file where this machine has a directory`);
    return false;
  }
  try {
    mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
    // The staged copy is ours: its mode is set before it moves, never through whatever `dest` is.
    await chmod(src, mode).catch(() => {});
    try {
      await move(src, dest);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
      await copyAcross(src, dest, mode);
    }
  } catch (error) {
    warn(`kept ${dest}: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
  return true;
}

export interface PlaceOptions {
  skipTop?: (name: string) => boolean;
  /** `/`-separated path under the tree; false keeps it out (a project's allowlist). */
  accept?: (rel: string) => boolean;
  warn?: (line: string) => void;
}

/**
 * Every file under `srcDir` placed at the same relative path under `destDir`. Directories are
 * made only to hold a file, and a destination that is a link or a file where the archive has a
 * directory is left alone with a warning — nothing is written through it.
 */
export async function placeTree(srcDir: string, destDir: string, options: PlaceOptions = {}): Promise<number> {
  const warn = options.warn ?? (() => {});
  let count = 0;
  const visit = async (src: string, dest: string, rel: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(src, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (rel === '' && options.skipTop?.(entry.name)) continue;
      const from = join(src, entry.name);
      const to = join(dest, entry.name);
      const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        const there = await kind(to);
        if (there !== 'missing' && there !== 'dir') {
          warn(`kept ${to}: the archive has a directory where this machine has a ${there === 'file' ? 'file' : 'link'}`);
          continue;
        }
        await visit(from, to, childRel);
      } else if (entry.isFile()) {
        if (options.accept && !options.accept(childRel)) continue;
        const info = await lstat(from);
        if (await placeFile(from, to, info.mode & 0o777 || 0o600, warn)) count += 1;
      }
    }
  };
  await visit(srcDir, destDir, '');
  return count;
}

const inside = (base: string, path: string): boolean => {
  const rel = relative(base, path);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
};

/** Where a project's files may go: the registry's root for it, or under the projects directory —
 *  both as this machine had them BEFORE the restore, never as the archive's own config says. */
export interface RootPolicy {
  registry: Array<{ id: string; root: string }>;
  projectsDir: string | null;
  /** Never a project root, nor anything inside it. */
  cezarHome: string;
}

/** The root a manifest project may be restored to, or why not. Never an arbitrary absolute path. */
export function resolveProjectRoot(project: BackupManifest['projects'][number], policy: RootPolicy): { root: string } | { reason: string } {
  if (!isAbsolutePath(project.root)) return { reason: 'its recorded root is not an absolute path here' };
  const root = resolve(project.root);
  const home = resolve(policy.cezarHome);
  if (dirname(root) === root || root === resolve(homedir()) || root === home || inside(home, root)) {
    return { reason: `its recorded root (${root}) is not a place a project can live` };
  }
  const registered = policy.registry.find((entry) => entry.id === project.id);
  if (registered && resolve(registered.root) === root) return { root };
  if (policy.projectsDir && isAbsolutePath(policy.projectsDir) && inside(resolve(policy.projectsDir), root)) return { root };
  return { reason: `its recorded root (${root}) is neither the registered root for ${project.id} nor under the projects directory` };
}

async function rootPolicyOf(cezarHome: string): Promise<RootPolicy> {
  const config = await loadWorkspaceConfig(join(cezarHome, 'config.json'));
  return { registry: config.projects, projectsDir: expandTilde(config.projectsDir), cezarHome };
}

export type CloneProject = (remote: string, root: string, branch: string | null) => Promise<void>;

const HOST = '[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?';
const REMOTE_GRAMMAR = [
  new RegExp(`^https://(?:[^\\s/@:]+(?::[^\\s/@]*)?@)?${HOST}(?::\\d{1,5})?/[^\\s]+$`),
  new RegExp(`^ssh://(?:[A-Za-z0-9._~-]+@)?${HOST}(?::\\d{1,5})?/[^\\s]+$`),
  // scp-like `git@github.com:owner/repo.git`; the user part keeps `C:\…` from passing for one.
  new RegExp(`^[A-Za-z0-9._~-]+@${HOST}:(?![/-])[^\\s]+$`),
];

/** A manifest's remote is input: https or ssh only, nothing git could read as an option or a transport. */
export function validCloneRemote(remote: string): boolean {
  return !remote.startsWith('-') && REMOTE_GRAMMAR.some((pattern) => pattern.test(remote));
}

const validBranch = (branch: string): boolean => /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]{1,255}$/.test(branch);

/** No prompt can block a restore: no terminal, no ssh password or host-key question. */
function nonInteractiveEnv(): NodeJS.ProcessEnv {
  const ssh = process.env.GIT_SSH_COMMAND?.trim();
  return { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: ssh ? `${ssh} -o BatchMode=yes` : 'ssh -o BatchMode=yes' };
}

function run(cwd: string, args: string[], timeout: number): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout, encoding: 'utf8', env: nonInteractiveEnv() }, (error, _stdout, stderr) => {
      if (!error) return resolve();
      // The remote URL may carry a token; git's stderr names it. Keep the last line, minus URLs.
      const last = String(stderr ?? '').trim().split('\n').pop()?.replace(/\S+:\/\/\S+/g, '<remote>') ?? '';
      reject(new Error(last || error.message));
    });
  });
}

export const cloneWithGit: CloneProject = async (remote, root, branch) => {
  if (!validCloneRemote(remote)) throw new Error('the recorded remote is not an https:// or ssh remote');
  if (branch !== null && !validBranch(branch)) throw new Error('the recorded branch is not a branch name');
  mkdirSync(dirname(root), { recursive: true });
  await run(dirname(root), ['clone', '--quiet', '--', remote, root], 30 * 60_000);
  if (branch) await run(root, ['checkout', '--quiet', branch, '--'], 60_000).catch(() => {});
};

const RUN_INDEX = '.ai/cezar/runs.json';
const RUN_EVENTS = /^\.ai\/cezar\/runs\/[^/]+\.ndjson$/;

/** A project's run index and per-run event files: merged by `mergeRunHistory`, never just placed. */
export const isRunHistory = (rel: string): boolean => rel === RUN_INDEX || RUN_EVENTS.test(rel);

type RawRun = Record<string, unknown> & { id: string };

const isRawRun = (row: unknown): row is RawRun =>
  !!row && typeof row === 'object' && !Array.isArray(row) && typeof (row as { id?: unknown }).id === 'string';

const RECENCY_FIELDS = ['createdAt', 'startedAt', 'finishedAt', 'archivedAt', 'pinnedAt', 'seenAt', 'worktreeReclaimedAt'];

/** A record without `updatedAt` (older stores): the latest instant it carries, its steps' included. */
function stampedRecency(run: Record<string, unknown>): number {
  let latest = -Infinity;
  const consider = (row: Record<string, unknown>) => {
    for (const field of RECENCY_FIELDS) {
      const at = typeof row[field] === 'string' ? Date.parse(row[field] as string) : Number.NaN;
      if (Number.isFinite(at) && at > latest) latest = at;
    }
  };
  consider(run);
  if (Array.isArray(run.steps)) for (const step of run.steps) if (step && typeof step === 'object') consider(step as Record<string, unknown>);
  return latest;
}

const updatedAt = (run: Record<string, unknown>): number =>
  typeof run.updatedAt === 'string' ? Date.parse(run.updatedAt) : Number.NaN;

/** Whether the archive's copy is newer: by the store's monotonic `updatedAt` when both carry one —
 *  an unpin or unarchive removes a stamp, so the heuristic would read it as older (round 4). Without
 *  both, a settled copy never is: its `finishedAt` is the backup's instant, not work. */
function archiveIsNewer(theirs: Record<string, unknown>, here: Record<string, unknown>): boolean {
  const [a, b] = [updatedAt(theirs), updatedAt(here)];
  if (Number.isFinite(a) && Number.isFinite(b)) return a > b;
  if (settledByBackup(theirs)) return false;
  return stampedRecency(theirs) > stampedRecency(here);
}

/**
 * This machine's index with the archive's folded in: a record only here is kept, one only in the
 * archive is added, and one in both takes the archive's copy only when that copy is newer.
 * `taken` and `kept` name the ids each side won, so the event files can follow their records.
 */
export function mergeRunIndex(here: unknown[], archived: unknown[]): {
  merged: unknown[]; added: number; updated: number; taken: Set<string>; kept: Set<string>;
} {
  const fromArchive = new Map(archived.filter(isRawRun).map((run) => [run.id, run]));
  const taken = new Set<string>();
  const kept = new Set<string>();
  const merged = here.map((row) => {
    if (!isRawRun(row)) return row;
    const theirs = fromArchive.get(row.id);
    if (!theirs) return row;
    fromArchive.delete(row.id);
    if (!archiveIsNewer(theirs, row)) {
      kept.add(row.id);
      return row;
    }
    taken.add(row.id);
    return theirs;
  });
  const updated = taken.size;
  for (const id of fromArchive.keys()) taken.add(id);
  return { merged: [...merged, ...fromArchive.values()], added: fromArchive.size, updated, taken, kept };
}

/** JSON off disk, or `undefined` when it is absent and `null` when it is unreadable. */
function readJsonFile(path: string): unknown {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/** Atomically, through a sibling named like `copyAcross`'s so the leftover sweep knows it. */
async function writeAtomically(dest: string, body: string): Promise<void> {
  const tmp = join(dirname(dest), `.${basename(dest)}.cezar-restore-${randomBytes(6).toString('hex')}`);
  try {
    await writeFile(tmp, body, { flag: 'wx', mode: 0o600 });
    await rename(tmp, dest);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
}

/**
 * Restore a project's run history WITHOUT losing what this machine did after the backup (spec
 * 2026-10-23 §10): the index merges (`mergeRunIndex`), and an event file follows its record — in
 * when the archive's record won, never when this machine's did, and otherwise only where this
 * machine has none or a shorter one. Files placed.
 */
async function mergeRunHistory(from: string, root: string, manifest: BackupManifest, log: (line: string) => void): Promise<number> {
  // As `placeTree` descends: nothing is read or written through a link or a file on the way.
  let at = root;
  for (const part of ['.ai', 'cezar', 'runs']) {
    at = join(at, part);
    const there = await kind(at);
    if (there === 'missing') break;
    if (there !== 'dir') {
      log(`kept ${at}: the archive has a directory where this machine has a ${there === 'file' ? 'file' : 'link'}`);
      return 0;
    }
  }
  let placed = 0;
  let taken = new Set<string>();
  let kept = new Set<string>();
  const destIndex = join(root, ...RUN_INDEX.split('/'));
  const archived = readJsonFile(join(from, ...RUN_INDEX.split('/')));
  if (archived !== undefined) {
    const there = await kind(destIndex);
    if (!Array.isArray(archived)) {
      log(`kept ${destIndex}: the archive's run index is not readable`);
    } else if (there === 'dir') {
      log(`kept ${destIndex}: the archive has a file where this machine has a directory`);
    } else {
      let here = there === 'file' ? readJsonFile(destIndex) : [];
      if (!Array.isArray(here)) {
        // Unreadable here, so nothing to merge with — but it is set aside, never overwritten.
        // Named through `join(dataDir, …)` so data-gitignore.test.ts sees it.
        const dataDir = dirname(destIndex);
        await rename(destIndex, join(dataDir, 'runs.json.before-restore')).catch(() => {});
        log(`moved an unreadable ${destIndex} aside to runs.json.before-restore`);
        here = [];
      }
      // An archive from before rows were settled at backup time is settled now, at its own instant.
      const createdAt = new Date(manifest.createdAt);
      const settled = settleLiveRuns(archived, `the backup from ${manifest.host}`, Number.isFinite(createdAt.getTime()) ? createdAt : new Date(0));
      const result = mergeRunIndex(here as unknown[], settled);
      const { merged, added, updated } = result;
      try {
        mkdirSync(dirname(destIndex), { recursive: true, mode: 0o700 });
        await writeAtomically(destIndex, JSON.stringify(merged));
        placed += 1;
        ({ taken, kept } = result);
        log(`merged task history: ${added} added, ${updated} updated from the archive, ${(here as unknown[]).length - updated} kept as they are here`);
      } catch (error) {
        log(`kept ${destIndex}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  const events = join(from, '.ai', 'cezar', 'runs');
  let entries;
  try {
    entries = await readdir(events, { withFileTypes: true });
  } catch {
    return placed;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !RUN_EVENTS.test(`.ai/cezar/runs/${entry.name}`)) continue;
    const id = entry.name.slice(0, -'.ndjson'.length);
    if (kept.has(id)) continue; // this machine's record stays, and so does its transcript
    const src = join(events, entry.name);
    const dest = join(root, '.ai', 'cezar', 'runs', entry.name);
    const info = await lstat(src);
    if (!taken.has(id) && (await kind(dest)) === 'file' && (await lstat(dest)).size >= info.size) continue;
    if (await placeFile(src, dest, info.mode & 0o777 || 0o600, log)) placed += 1;
  }
  return placed;
}

/** The sibling `copyAcross` and `writeAtomically` create, exactly — nothing else is ever swept. */
const LEFTOVER_RE = /^\..+\.cezar-restore-[0-9a-f]{12}$/;

/** What a restore places into: trees it walks, and single files whose siblings it checks. */
export interface RestoreTargets {
  trees: string[];
  files: string[];
}

/**
 * Remove the half-copied siblings a crash between copy and rename left (review 2026-10-24,
 * round 3). Never follows a link, never enters `node_modules`, `.git` or task worktrees, and
 * walks `CEZ_HOME` only where a restore places files.
 */
export async function sweepRestoreLeftovers(targets: RestoreTargets, cezarHome: string): Promise<number> {
  let removed = 0;
  const drop = async (path: string) => {
    await rm(path, { force: true }).then(() => { removed += 1; }, () => {});
  };
  const walk = async (root: string): Promise<void> => {
    const isHome = resolve(root) === resolve(cezarHome);
    const visit = async (dir: string, top: boolean): Promise<void> => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (top && isHome && isSkippedDataEntry(entry.name)) continue;
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || entry.name === '.git' || path === join(root, '.ai', 'cezar', 'worktrees')) continue;
          await visit(path, false);
        } else if (entry.isFile() && LEFTOVER_RE.test(entry.name)) {
          await drop(path);
        }
      }
    };
    await visit(root, true);
  };
  for (const tree of new Set(targets.trees)) await walk(tree);
  for (const file of new Set(targets.files)) {
    const prefix = `.${basename(file)}.cezar-restore-`;
    let entries;
    try {
      entries = await readdir(dirname(file), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isFile() && entry.name.startsWith(prefix) && LEFTOVER_RE.test(entry.name)) await drop(join(dirname(file), entry.name));
    }
  }
  return removed;
}

/** Boot: a journal means a restore stopped mid-placement — sweep where it was placing, once. */
export async function sweepAfterInterruptedRestore(log: (line: string) => void = console.log): Promise<void> {
  const path = restoreJournalPath();
  let targets: RestoreTargets;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<RestoreTargets>;
    const strings = (value: unknown) => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && isAbsolutePath(item)) : []);
    targets = { trees: strings(raw.trees), files: strings(raw.files) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    targets = { trees: [], files: [] };
  }
  const removed = await sweepRestoreLeftovers(targets, cezarHomeDir());
  rmSync(path, { force: true });
  if (removed > 0) log(`  removed ${removed} leftover file(s) of a restore that did not finish`);
}

export interface ApplyInput {
  staging: string;
  manifest: BackupManifest;
  cezarHome: string;
  locations: AgentStateLocations;
  clone?: CloneProject;
  /** Absent: this machine's registry and projects dir, read before the data half is placed — on
   *  a fresh `/setup` that is no project and `CEZ_PROJECTS_DIR` (or its default). */
  rootPolicy?: RootPolicy;
  log: (line: string) => void;
}

/** Put a staged archive in place: cezar's state, then the logins (a clone may need `gh`'s), then projects. */
export async function applyStaged(input: ApplyInput): Promise<void> {
  const { manifest, log } = input;
  // Read before anything lands: the archive's config.json must not vouch for its own roots.
  const policy = input.rootPolicy ?? (await rootPolicyOf(input.cezarHome));
  const agentTargets = agentEntries(input.locations);
  const targets: RestoreTargets = {
    trees: [
      input.cezarHome,
      ...agentTargets.filter((entry) => entry.kind === 'dir').map((entry) => entry.path),
      ...manifest.projects.flatMap((project) => {
        const resolved = resolveProjectRoot(project, policy);
        return 'root' in resolved ? [resolved.root] : [];
      }),
    ],
    files: agentTargets.filter((entry) => entry.kind === 'file').map((entry) => entry.path),
  };
  // What an earlier restore that crashed between copy and rename left behind (review round 3).
  const swept = await sweepRestoreLeftovers(targets, input.cezarHome);
  if (swept > 0) log(`removed ${swept} leftover file(s) of an earlier restore that did not finish`);
  const journal = restoreJournalPath();
  try {
    writeFileSync(journal, `${JSON.stringify(targets)}\n`, { mode: 0o600 });
  } catch {
    /* best-effort: the next restore sweeps anyway */
  }
  try {
    await placeStaged(input, policy);
  } finally {
    rmSync(journal, { force: true });
  }
}

async function placeStaged(input: ApplyInput, policy: RootPolicy): Promise<void> {
  const { staging, manifest, log } = input;
  const data = await placeTree(join(staging, 'data'), input.cezarHome, { skipTop: isSkippedDataEntry, warn: log });
  log(`restored cezar state (${data} files)`);

  let agents = 0;
  for (const entry of agentEntries(input.locations)) {
    const from = join(staging, ...entry.archive.split('/'));
    if (!existsSync(from)) continue;
    if (entry.kind === 'file') {
      const info = await lstat(from);
      if (!info.isFile()) continue;
      if (await placeFile(from, entry.path, info.mode & 0o777 || 0o600, log)) agents += 1;
    } else {
      mkdirSync(entry.path, { recursive: true, mode: 0o700 });
      agents += await placeTree(from, entry.path, { warn: log });
      if (entry.archive === 'agents/ssh') await chmod(entry.path, 0o700).catch(() => {});
    }
  }
  // Claude's `.claude.json` sits beside its dir by default and inside it under an override.
  if (!input.locations.claudeState && existsSync(join(staging, 'agents', 'claude.json'))) {
    if (await placeFile(join(staging, 'agents', 'claude.json'), join(input.locations.claude, '.claude.json'), 0o600, log)) agents += 1;
  }
  log(`restored agent logins (${agents} files)`);

  const clone = input.clone ?? cloneWithGit;
  for (const project of manifest.projects) {
    const from = join(staging, 'projects', project.id);
    const resolved = resolveProjectRoot(project, policy);
    if ('reason' in resolved) {
      log(`skipped ${project.id}: ${resolved.reason}`);
      continue;
    }
    const { root } = resolved;
    if (!existsSync(root)) {
      if (!project.remote) {
        log(`skipped ${project.id}: not on disk and it has no remote to clone`);
        continue;
      }
      log(`cloning ${project.id}…`);
      try {
        await clone(project.remote, root, project.branch);
      } catch (error) {
        log(`could not clone ${project.id}: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
    }
    // Run history merges in (it never replaces what this machine has), then the allowlist
    // again: an archive is input, not an authority on what a project may hold.
    const history = existsSync(from) ? await mergeRunHistory(from, root, manifest, log) : 0;
    const files = existsSync(from)
      ? await placeTree(from, root, { accept: (rel) => projectFileQualifies(rel) && !isRunHistory(rel), warn: log })
      : 0;
    log(`restored ${project.id} (${files + history} files)`);
  }
}
