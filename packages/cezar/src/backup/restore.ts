import { execFile } from 'node:child_process';
import { createReadStream, createWriteStream, existsSync, mkdirSync } from 'node:fs';
import { chmod, copyFile, lstat, readdir, rename } from 'node:fs/promises';
import { Writable } from 'node:stream';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { expandTilde, isAbsolutePath, type AgentStateLocations } from '../paths.ts';
import { loadWorkspaceConfig } from '../workspace/config.ts';
import { decompressed, decrypted } from './codec.ts';
import { agentEntries, backupManifestSchema, isSkippedDataEntry, projectFileQualifies, type BackupManifest } from './collect.ts';
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

/** Move `src` over `dest`, across filesystems when it has to. A directory at `dest` is never removed. */
async function place(src: string, dest: string, mode: number, warn: (line: string) => void): Promise<boolean> {
  if ((await kind(dest)) === 'dir') {
    warn(`kept ${dest}: the archive has a file where this machine has a directory`);
    return false;
  }
  try {
    mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
    try {
      await rename(src, dest);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
      await copyFile(src, dest);
    }
  } catch (error) {
    warn(`kept ${dest}: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
  await chmod(dest, mode).catch(() => {});
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
        if (await place(from, to, info.mode & 0o777 || 0o600, warn)) count += 1;
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

/** Where a project's files may go: the registry's root for it, or under the projects directory. */
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

export interface ApplyInput {
  staging: string;
  manifest: BackupManifest;
  cezarHome: string;
  locations: AgentStateLocations;
  clone?: CloneProject;
  /** Absent: the workspace registry the data half just put in place, and its projects dir. */
  rootPolicy?: RootPolicy;
  log: (line: string) => void;
}

/** Put a staged archive in place: cezar's state, then the logins (a clone may need `gh`'s), then projects. */
export async function applyStaged(input: ApplyInput): Promise<void> {
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
      if (await place(from, entry.path, info.mode & 0o777 || 0o600, log)) agents += 1;
    } else {
      mkdirSync(entry.path, { recursive: true, mode: 0o700 });
      agents += await placeTree(from, entry.path, { warn: log });
      if (entry.archive === 'agents/ssh') await chmod(entry.path, 0o700).catch(() => {});
    }
  }
  // Claude's `.claude.json` sits beside its dir by default and inside it under an override.
  if (!input.locations.claudeState && existsSync(join(staging, 'agents', 'claude.json'))) {
    if (await place(join(staging, 'agents', 'claude.json'), join(input.locations.claude, '.claude.json'), 0o600, log)) agents += 1;
  }
  log(`restored agent logins (${agents} files)`);

  const clone = input.clone ?? cloneWithGit;
  const policy = input.rootPolicy ?? (await rootPolicyOf(input.cezarHome));
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
    // The allowlist again: an archive is input, not an authority on what a project may hold.
    const files = existsSync(from) ? await placeTree(from, root, { accept: projectFileQualifies, warn: log }) : 0;
    log(`restored ${project.id} (${files} files)`);
  }
}
