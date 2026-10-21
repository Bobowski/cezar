import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { worktreeLifecycleConfigSchema, type WorktreeLifecycleConfig } from '@open-mercato/cezar-contract';
import { assertLifecyclePath, atomicLifecycleWrite, LifecycleConflictError, LifecycleStoreError, withLifecycleFileLock } from './store.ts';

export class LifecycleConfigError extends Error {}
export type LifecycleConfigSnapshot = { config: WorktreeLifecycleConfig; revision: string | null; configured: boolean };

export function lifecycleConfigFromRaw(raw: unknown): LifecycleConfigSnapshot {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new LifecycleConfigError('Project configuration must be a JSON object');
  if (!Object.hasOwn(raw, 'worktreeLifecycle')) return { config: { afterCreate: [], beforeRemove: [] }, revision: null, configured: false };
  const value = (raw as Record<string, unknown>).worktreeLifecycle;
  const parsed = worktreeLifecycleConfigSchema.safeParse(value);
  if (!parsed.success) throw new LifecycleConfigError(`Invalid worktree lifecycle configuration: ${parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`);
  // Hash the authored value, including unknown future keys; direct file edits participate in CAS.
  return { config: parsed.data, revision: createHash('sha256').update(JSON.stringify(value)).digest('hex'), configured: true };
}

/** Where scripts live when the shared config.json is committed: untracked, beside it (like
 *  mcp.local.json). It wins when it carries the key, so a team's config.json can stay in git. */
export const LOCAL_CONFIG_FILE = 'config.local.json';
type ConfigFile = 'config.json' | typeof LOCAL_CONFIG_FILE;
const configPath = (projectRoot: string, file: ConfigFile) => join(projectRoot, '.ai', 'cezar', file);

export async function readLifecycleConfigRaw(projectRoot: string): Promise<Record<string, unknown>> {
  return readConfigObject(projectRoot, 'config.json');
}
export async function readLocalConfigRaw(projectRoot: string): Promise<Record<string, unknown>> {
  return readConfigObject(projectRoot, LOCAL_CONFIG_FILE);
}
async function readConfigObject(projectRoot: string, file: ConfigFile): Promise<Record<string, unknown>> {
  const path = configPath(projectRoot, file);
  await assertLifecyclePath(path, projectRoot);
  let text: string;
  try { text = await readFile(path, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new LifecycleConfigError('Project configuration cannot be read; worktree transition is paused');
  }
  try {
    const raw: unknown = JSON.parse(text);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('not an object');
    return raw as Record<string, unknown>;
  } catch { throw new LifecycleConfigError('Project configuration is malformed; worktree transition is paused'); }
}
const UNCONFIGURED: LifecycleConfigSnapshot = { config: { afterCreate: [], beforeRemove: [] }, revision: null, configured: false };
export const TRACKED_CONFIG_ERROR = 'Worktree scripts in a git-tracked .ai/cezar/config.local.json are not run: scripts come only from local, untracked configuration. Untrack the file.';

/** A committed hook list would run on every clone with no consent (spec: local configuration only). */
export async function isLifecycleConfigTracked(projectRoot: string, file: ConfigFile = 'config.json'): Promise<boolean> {
  return promisify(execFile)('git', ['ls-files', '--error-unmatch', '--', join('.ai', 'cezar', file)], { cwd: projectRoot })
    .then(() => true, () => false);
}
/** The scripts Cezar may execute. Fails closed on an invalid list; a committed list counts as none. */
export async function readLifecycleConfig(projectRoot: string): Promise<LifecycleConfigSnapshot> {
  const source = await lifecycleSource(projectRoot);
  return trusted(projectRoot, lifecycleConfigFromRaw(source.raw), source.file);
}
/** The file the scripts are read from: config.local.json when it carries the key, else config.json. */
async function lifecycleSource(projectRoot: string): Promise<{ raw: Record<string, unknown>; file: ConfigFile }> {
  const local = await readLocalConfigRaw(projectRoot);
  if (Object.hasOwn(local, 'worktreeLifecycle')) return { raw: local, file: LOCAL_CONFIG_FILE };
  return { raw: await readLifecycleConfigRaw(projectRoot), file: 'config.json' };
}
/** Zero-config read for "are scripts configured?": an unreadable or malformed file, or a symlinked
 *  data directory, means none — what `loadConfig` already degrades to. A present key still fails closed. */
export async function readLifecycleConfigOrDefault(projectRoot: string, options: { trust?: boolean } = {}): Promise<LifecycleConfigSnapshot> {
  let source: { raw: Record<string, unknown>; file: ConfigFile };
  try { source = await lifecycleSource(projectRoot); }
  catch (error) {
    if (error instanceof LifecycleConfigError || error instanceof LifecycleStoreError) return UNCONFIGURED;
    throw error;
  }
  const snapshot = lifecycleConfigFromRaw(source.raw);
  // Settings shows an untrusted (committed) list too, so the user can remove it.
  return options.trust === false ? snapshot : trusted(projectRoot, snapshot, source.file);
}
// Treated as unconfigured rather than an error, so a repo that ships scripts keeps the zero-config path.
async function trusted(projectRoot: string, snapshot: LifecycleConfigSnapshot, file: ConfigFile): Promise<LifecycleConfigSnapshot> {
  const scripts = snapshot.config.afterCreate.length + snapshot.config.beforeRemove.length;
  return scripts > 0 && await isLifecycleConfigTracked(projectRoot, file) ? UNCONFIGURED : snapshot;
}
export async function withLifecycleConfigLock<T>(projectRoot: string, action: () => Promise<T>): Promise<T> {
  const path = join(projectRoot, '.ai', 'cezar', 'config.lifecycle.lock');
  await assertLifecyclePath(path, projectRoot);
  return withLifecycleFileLock(path, action);
}
/** Call under withLifecycleConfigLock together with the surrounding raw read/merge/write. */
export function applyLifecycleConfigUpdate(raw: Record<string, unknown>, config: WorktreeLifecycleConfig | null, expectedRevision: string | null): Record<string, unknown> {
  const current = lifecycleConfigFromRaw(raw);
  if (current.revision !== expectedRevision) throw new LifecycleConflictError('Worktree scripts changed; reload settings before saving');
  const next = { ...raw };
  if (config === null) { delete next.worktreeLifecycle; delete next.worktreeLifecycleRevision; }
  else {
    // Entry validation never trims authored command text. Preserve future keys for surviving IDs.
    const parsed = worktreeLifecycleConfigSchema.parse(config);
    const old = raw.worktreeLifecycle as Record<string, unknown> | undefined;
    const oldEntries = new Map<string, Record<string, unknown>>();
    for (const phase of ['afterCreate', 'beforeRemove']) {
      const entries = old?.[phase];
      if (Array.isArray(entries)) for (const entry of entries) if (entry && typeof entry === 'object' && typeof entry.id === 'string') oldEntries.set(entry.id, entry);
    }
    const preserve = (entries: WorktreeLifecycleConfig['afterCreate']) => entries.map(entry => {
      const previous = { ...oldEntries.get(entry.id) };
      delete previous.name; delete previous.timeoutSeconds;
      return { ...previous, ...entry };
    });
    next.worktreeLifecycle = { ...old, afterCreate: preserve(parsed.afterCreate), beforeRemove: preserve(parsed.beforeRemove) };
    delete next.worktreeLifecycleRevision; // revisions are derived, never trusted from disk
  }
  return next;
}
/**
 * Saves scripts into config.local.json; call under withLifecycleConfigLock. `sharedRaw` is the
 * caller's config.json object: an untracked one loses its key (the list moved) and the caller
 * writes it back; a tracked one is the team's file and is never touched.
 */
export async function saveLifecycleConfigLocked(
  projectRoot: string,
  config: WorktreeLifecycleConfig | null,
  expectedRevision: string | null,
  sharedRaw: Record<string, unknown>,
): Promise<{ snapshot: LifecycleConfigSnapshot; sharedChanged: boolean }> {
  const local = await readLocalConfigRaw(projectRoot);
  const base = { ...local };
  const sharedHasKey = Object.hasOwn(sharedRaw, 'worktreeLifecycle');
  // Revision and preserved future keys follow the list in force now, wherever it lives.
  if (!Object.hasOwn(local, 'worktreeLifecycle') && sharedHasKey) base.worktreeLifecycle = sharedRaw.worktreeLifecycle;
  const next = applyLifecycleConfigUpdate(base, config, expectedRevision);
  const scripts = config ? config.afterCreate.length + config.beforeRemove.length : 0;
  if (scripts > 0 && await isLifecycleConfigTracked(projectRoot, LOCAL_CONFIG_FILE)) throw new LifecycleConfigError(TRACKED_CONFIG_ERROR);
  await atomicLifecycleWrite(configPath(projectRoot, LOCAL_CONFIG_FILE), next);
  let sharedChanged = false;
  if (sharedHasKey && !await isLifecycleConfigTracked(projectRoot)) {
    delete sharedRaw.worktreeLifecycle;
    delete sharedRaw.worktreeLifecycleRevision;
    sharedChanged = true;
  }
  return { snapshot: lifecycleConfigFromRaw(next), sharedChanged };
}
export async function writeLifecycleConfig(projectRoot: string, config: WorktreeLifecycleConfig | null, expectedRevision: string | null): Promise<LifecycleConfigSnapshot> {
  return withLifecycleConfigLock(projectRoot, async () => {
    const shared = await readLifecycleConfigRaw(projectRoot);
    const { snapshot, sharedChanged } = await saveLifecycleConfigLocked(projectRoot, config, expectedRevision, shared);
    if (sharedChanged) await atomicLifecycleWrite(configPath(projectRoot, 'config.json'), shared);
    return snapshot;
  });
}
