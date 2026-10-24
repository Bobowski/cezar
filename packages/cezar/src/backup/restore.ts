import { execFile } from 'node:child_process';
import { createReadStream, createWriteStream, existsSync, mkdirSync } from 'node:fs';
import { chmod, copyFile, lstat, readdir, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isAbsolutePath, type AgentStateLocations } from '../paths.ts';
import { decompressed, decrypted } from './codec.ts';
import { agentEntries, backupManifestSchema, isSkippedDataEntry, type BackupManifest } from './collect.ts';
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

/** Decrypt + decompress + untar `archive` into `staging`, then answer its manifest. */
export async function stageArchive(archive: string, identity: string, staging: string): Promise<BackupManifest> {
  mkdirSync(staging, { recursive: true, mode: 0o700 });
  const plain = await decrypted(createReadStream(archive), identity);
  const tar = await decompressed(plain);
  await readTar(tar, (entry) => {
    const rel = safeArchivePath(entry.name);
    if (!rel) throw new Error(`the archive holds a path outside its own layout (${entry.name.slice(0, 120)})`);
    const abs = join(staging, ...rel.split('/'));
    if (entry.type === 'dir') {
      mkdirSync(abs, { recursive: true, mode: 0o700 });
      return null;
    }
    if (entry.type !== 'file') return null;
    mkdirSync(dirname(abs), { recursive: true, mode: 0o700 });
    return createWriteStream(abs, { mode: entry.mode & 0o777 || 0o600 });
  });
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(join(staging, 'manifest.json'), 'utf8'));
  } catch {
    throw new Error('the archive has no readable manifest — it is not a cezar backup');
  }
  const parsed = backupManifestSchema.safeParse(raw);
  if (!parsed.success) throw new Error('the archive manifest is not one this cezar understands');
  return parsed.data;
}

/** Move `src` over `dest`, across filesystems when it has to. */
async function place(src: string, dest: string, mode: number): Promise<void> {
  mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
  try {
    if ((await lstat(dest)).isDirectory()) await rm(dest, { recursive: true, force: true });
  } catch { /* nothing there */ }
  try {
    await rename(src, dest);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
    await copyFile(src, dest);
  }
  await chmod(dest, mode).catch(() => {});
}

/** Every file under `srcDir` placed at the same relative path under `destDir`. */
export async function placeTree(srcDir: string, destDir: string, skipTop?: (name: string) => boolean): Promise<number> {
  let count = 0;
  const visit = async (src: string, dest: string, top: boolean): Promise<void> => {
    let entries;
    try {
      entries = await readdir(src, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (top && skipTop?.(entry.name)) continue;
      const from = join(src, entry.name);
      const to = join(dest, entry.name);
      if (entry.isDirectory()) {
        const info = await lstat(from);
        mkdirSync(to, { recursive: true, mode: info.mode & 0o777 || 0o700 });
        await visit(from, to, false);
      } else if (entry.isFile()) {
        const info = await lstat(from);
        await place(from, to, info.mode & 0o777 || 0o600);
        count += 1;
      }
    }
  };
  await visit(srcDir, destDir, true);
  return count;
}

export type CloneProject = (remote: string, root: string, branch: string | null) => Promise<void>;

function run(cwd: string, args: string[], timeout: number): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout, encoding: 'utf8' }, (error, _stdout, stderr) => {
      if (!error) return resolve();
      // The remote URL may carry a token; git's stderr names it. Keep the last line, minus URLs.
      const last = String(stderr ?? '').trim().split('\n').pop()?.replace(/\S+:\/\/\S+/g, '<remote>') ?? '';
      reject(new Error(last || error.message));
    });
  });
}

export const cloneWithGit: CloneProject = async (remote, root, branch) => {
  mkdirSync(dirname(root), { recursive: true });
  await run(dirname(root), ['clone', '--quiet', remote, root], 30 * 60_000);
  if (branch) await run(root, ['checkout', '--quiet', branch], 60_000).catch(() => {});
};

export interface ApplyInput {
  staging: string;
  manifest: BackupManifest;
  cezarHome: string;
  locations: AgentStateLocations;
  clone?: CloneProject;
  log: (line: string) => void;
}

/** Put a staged archive in place: cezar's state, then the logins (a clone may need `gh`'s), then projects. */
export async function applyStaged(input: ApplyInput): Promise<void> {
  const { staging, manifest, log } = input;
  const data = await placeTree(join(staging, 'data'), input.cezarHome, isSkippedDataEntry);
  log(`restored cezar state (${data} files)`);

  let agents = 0;
  for (const entry of agentEntries(input.locations)) {
    const from = join(staging, ...entry.archive.split('/'));
    if (!existsSync(from)) continue;
    if (entry.kind === 'file') {
      const info = await lstat(from);
      if (!info.isFile()) continue;
      await place(from, entry.path, info.mode & 0o777 || 0o600);
      agents += 1;
    } else {
      mkdirSync(entry.path, { recursive: true, mode: 0o700 });
      agents += await placeTree(from, entry.path);
      if (entry.archive === 'agents/ssh') await chmod(entry.path, 0o700).catch(() => {});
    }
  }
  // Claude's `.claude.json` sits beside its dir by default and inside it under an override.
  if (!input.locations.claudeState && existsSync(join(staging, 'agents', 'claude.json'))) {
    await place(join(staging, 'agents', 'claude.json'), join(input.locations.claude, '.claude.json'), 0o600);
    agents += 1;
  }
  log(`restored agent logins (${agents} files)`);

  const clone = input.clone ?? cloneWithGit;
  for (const project of manifest.projects) {
    const from = join(staging, 'projects', project.id);
    if (!isAbsolutePath(project.root)) {
      log(`skipped ${project.id}: its recorded root is not an absolute path here`);
      continue;
    }
    if (!existsSync(project.root)) {
      if (!project.remote) {
        log(`skipped ${project.id}: not on disk and it has no remote to clone`);
        continue;
      }
      log(`cloning ${project.id}…`);
      try {
        await clone(project.remote, project.root, project.branch);
      } catch (error) {
        log(`could not clone ${project.id}: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
    }
    const files = existsSync(from) ? await placeTree(from, project.root) : 0;
    log(`restored ${project.id} (${files} files)`);
  }
}
