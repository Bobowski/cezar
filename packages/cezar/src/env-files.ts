import { createHash, randomBytes } from 'node:crypto';
import { chmod, lstat, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ENV_FILE_MAX_BYTES, envFilePathIssue, isEnvFileName, parseEnv,
  type EnvFileContent, type EnvFileEntry, type EnvFileRender, type EnvFilesList,
} from '@open-mercato/cezar-contract';
import { EnvReferenceError, hasDirectives, readDirectives, renderEnvFiles, type EnvRenderContext } from './env-references.ts';
import { ENV_WALK_MAX_DEPTH, ENV_WALK_SKIP_DIRS, SERVICE_MANIFESTS, ignoredAmong, isDependencyVendorDir, projectEnvFiles, writeEnvText } from './worktree-env.ts';

/**
 * The project's env files, listed and edited in the main checkout (spec
 * `.ai/specs/2026-10-12-project-env-files.md`).
 *
 * Nothing here is stored by cezar: the file on disk is the state, and `worktree-env.ts` carries
 * it into each new task worktree. Which paths count is git's answer, as there — only a path the
 * repo IGNORES is listed or written, so a save can never become a commit.
 */

const TEMPLATE_SUFFIXES = ['.example', '.sample', '.template', '.dist'];
const MAX_DIRS = 4000;
const MAX_LISTED = 64;
const MAX_SUGGESTIONS = 24;

export type EnvFileResult<T> = { ok: true; value: T } | { ok: false; status: 400 | 404 | 409; error: string };

const refuse = (status: 400 | 404 | 409, error: string) => ({ ok: false as const, status, error });

/** `.env.example` → `.env`; `null` for a name that is not an example of an env file. */
function templateTarget(name: string): string | null {
  const suffix = TEMPLATE_SUFFIXES.find((candidate) => name.endsWith(candidate));
  if (!suffix) return null;
  const target = name.slice(0, -suffix.length);
  return isEnvFileName(target) ? target : null;
}

const dirOf = (path: string): string => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
const inDir = (dir: string, name: string): string => (dir === '' ? name : `${dir}/${name}`);

/** The names a dotenv text sets, in order, each once. Values are never returned. */
export function envVariableNames(text: string): string[] {
  const names: string[] = [];
  for (const line of text.split('\n')) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (match && !names.includes(match[1] as string)) names.push(match[1] as string);
  }
  return names;
}

async function readText(path: string): Promise<{ text: string; updatedAt: string } | null> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.size > ENV_FILE_MAX_BYTES) return null;
    return { text: await readFile(path, 'utf8'), updatedAt: info.mtime.toISOString() };
  } catch {
    return null;
  }
}

/** Every env-named file and every service directory under `root`, repo-relative. */
async function walk(root: string): Promise<{ envNamed: string[]; services: string[] }> {
  const envNamed: string[] = [];
  const services: string[] = [];
  let opened = 0;
  const visit = async (rel: string, depth: number): Promise<void> => {
    if (opened >= MAX_DIRS) return;
    opened += 1;
    let entries;
    try {
      entries = await readdir(rel === '' ? root : join(root, rel), { withFileTypes: true });
    } catch {
      return;
    }
    // Another checkout (a nested repository, a task worktree): its env files are that tree's.
    if (rel !== '' && entries.some((entry) => entry.name === '.git')) return;
    if (isDependencyVendorDir(rel, entries.map((entry) => entry.name))) return;
    if (entries.some((entry) => entry.isFile() && SERVICE_MANIFESTS.has(entry.name))) services.push(rel);
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isFile()) {
        if (isEnvFileName(entry.name)) envNamed.push(inDir(rel, entry.name));
      } else if (entry.isDirectory() && depth < ENV_WALK_MAX_DEPTH && !ENV_WALK_SKIP_DIRS.has(entry.name)) {
        await visit(inDir(rel, entry.name), depth + 1);
      }
    }
  };
  await visit('', 0);
  return { envNamed, services };
}

/** The listing: files that exist, files a tracked example asks for, and likely paths with neither. */
export async function listEnvFiles(root: string, editable: boolean): Promise<EnvFilesList> {
  const { envNamed, services } = await walk(root);
  const templateOf = new Map<string, string>();
  const plain: string[] = [];
  for (const path of envNamed) {
    const name = path.slice(path.lastIndexOf('/') + 1);
    const target = templateTarget(name);
    if (target) templateOf.set(inDir(dirOf(path), target), path);
    else plain.push(path);
  }
  const likely = services.map((dir) => inDir(dir, '.env'));
  const ignored = new Set(await ignoredAmong(root, [...new Set([...envNamed, ...templateOf.keys(), ...likely])]));

  const paths = new Set(plain.filter((path) => ignored.has(path)));
  // An example that is itself ignored is somebody's local file, not the repo's request.
  for (const [target, template] of templateOf) if (ignored.has(target) && !ignored.has(template)) paths.add(target);

  const files: EnvFileEntry[] = [];
  for (const path of [...paths].sort().slice(0, MAX_LISTED)) {
    const current = await readText(join(root, path));
    const template = templateOf.get(path);
    const tracked = template && !ignored.has(template) ? template : null;
    const variables = current ? envVariableNames(current.text) : [];
    const wanted = tracked ? envVariableNames((await readText(join(root, tracked)))?.text ?? '') : [];
    files.push({
      path,
      exists: current !== null,
      variables,
      template: tracked,
      missing: wanted.filter((name) => !variables.includes(name)),
      updatedAt: current?.updatedAt ?? null,
    });
  }
  const suggestions = likely.filter((path) => ignored.has(path) && !paths.has(path)).sort().slice(0, MAX_SUGGESTIONS);
  return { editable, files, suggestions };
}

/**
 * Where `path` lands on disk, or why it may not be touched. Every directory on the way must be a
 * real directory of THIS checkout, and git must ignore the path — the property that keeps a
 * saved secret out of `git add -A`.
 */
async function resolveTarget(root: string, path: string): Promise<EnvFileResult<{ abs: string; exists: boolean }>> {
  const issue = envFilePathIssue(path);
  if (issue) return refuse(400, issue);
  const segments = path.split('/');
  let dir = root;
  for (const segment of segments.slice(0, -1)) {
    dir = join(dir, segment);
    let entries: string[];
    try {
      if (!(await lstat(dir)).isDirectory()) return refuse(409, `${segment} is not a directory of this repository`);
      entries = await readdir(dir);
    } catch {
      return refuse(409, `the directory for ${path} does not exist`);
    }
    if (entries.includes('.git')) return refuse(409, `${path} belongs to another checkout`);
  }
  const abs = join(dir, segments[segments.length - 1] as string);
  let exists = false;
  try {
    if (!(await lstat(abs)).isFile()) return refuse(409, `${path} is not a regular file`);
    exists = true;
  } catch {
    // Absent: a file about to be created.
  }
  if ((await ignoredAmong(root, [path])).length === 0) {
    return refuse(409, `git does not ignore ${path} — add it to .gitignore first, so a saved value cannot be committed`);
  }
  return { ok: true, value: { abs, exists } };
}

const versionOf = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

async function templateText(root: string, path: string): Promise<string | null> {
  const candidates = TEMPLATE_SUFFIXES.map((suffix) => `${path}${suffix}`);
  const ignored = new Set(await ignoredAmong(root, candidates));
  for (const candidate of candidates) {
    if (ignored.has(candidate)) continue;
    const text = await readText(join(root, candidate));
    if (text) return text.text;
  }
  return null;
}

async function readTarget(root: string, path: string, target: { abs: string; exists: boolean }): Promise<EnvFileResult<EnvFileContent>> {
  const template = await templateText(root, path);
  if (!target.exists) return { ok: true, value: { path, content: '', version: null, template } };
  try {
    const bytes = await readFile(target.abs);
    if (bytes.length > ENV_FILE_MAX_BYTES) return refuse(409, `${path} is larger than ${ENV_FILE_MAX_BYTES} bytes`);
    return { ok: true, value: { path, content: bytes.toString('utf8'), version: versionOf(bytes), template } };
  } catch {
    return refuse(409, `${path} could not be read`);
  }
}

export async function readEnvFile(root: string, path: string): Promise<EnvFileResult<EnvFileContent>> {
  const target = await resolveTarget(root, path);
  return target.ok ? readTarget(root, path, target.value) : target;
}

/**
 * The main checkout's render of every env file (spec 2026-10-21-env-references), with `path` as
 * it is about to be saved: the saved text with its own directives filled in, and any OTHER file
 * whose directives read from it. Without a directive anywhere this is only the walk.
 */
async function renderForSave(root: string, path: string, content: string, context: EnvRenderContext = { projectRoot: root, worktreePath: root }): Promise<EnvFileResult<Map<string, string>>> {
  const files = new Map<string, string>();
  for (const rel of await projectEnvFiles(root)) {
    if (rel === path) continue;
    const text = await readText(join(root, rel));
    if (text) files.set(rel, text.text);
  }
  files.set(path, content);
  if (![...files.values()].some(hasDirectives)) return { ok: true, value: new Map() };
  try {
    return { ok: true, value: renderEnvFiles(files, context) };
  } catch (error) {
    if (error instanceof EnvReferenceError) return refuse(400, error.message);
    throw error;
  }
}

/**
 * What `content` would render to, without writing anything: in the main checkout, or for a task
 * (`context` with its worktree and slot) — the file a NEW seeding of that task would produce,
 * since other files are read from the main checkout (spec 2026-10-21-env-references §5).
 */
export async function previewEnvFile(root: string, path: string, content: string, context: EnvRenderContext): Promise<EnvFileResult<EnvFileRender>> {
  if (Buffer.byteLength(content, 'utf8') > ENV_FILE_MAX_BYTES) return refuse(400, `an env file is at most ${ENV_FILE_MAX_BYTES} bytes`);
  const target = await resolveTarget(root, path);
  if (!target.ok) return target;
  const rendered = await renderForSave(root, path, content, context);
  if (!rendered.ok) return rendered;
  const text = rendered.value.get(path) ?? content;
  const keys = new Set(readDirectives(path, content).map((directive) => directive.key));
  const values = parseEnv(text).flatMap((line) => (line.kind === 'var' && keys.has(line.key) ? [{ key: line.key, value: line.value }] : []));
  return { ok: true, value: { rendered: text, values, slot: context.slot ?? null } };
}

/** Save `submitted` as `path`. `version` is what the editor loaded; a file that moved on is not overwritten. */
export async function writeEnvFile(
  root: string,
  path: string,
  submitted: string,
  version: string | null,
): Promise<EnvFileResult<EnvFileContent>> {
  if (Buffer.byteLength(submitted, 'utf8') > ENV_FILE_MAX_BYTES) return refuse(400, `an env file is at most ${ENV_FILE_MAX_BYTES} bytes`);
  if (submitted.includes('\0')) return refuse(400, 'an env file is text, without NUL');
  const target = await resolveTarget(root, path);
  if (!target.ok) return target;
  const current = await readTarget(root, path, target.value);
  if (!current.ok) return current;
  if (current.value.version !== version) {
    return refuse(409, `${path} changed on disk since it was opened — reload it before saving`);
  }
  // `#cezar` directives are filled in with the main checkout's values before anything is written.
  const rendered = await renderForSave(root, path, submitted);
  if (!rendered.ok) return rendered;
  const content = rendered.value.get(path) ?? submitted;
  const bytes = Buffer.from(content, 'utf8');
  if (bytes.length > ENV_FILE_MAX_BYTES) return refuse(400, `an env file is at most ${ENV_FILE_MAX_BYTES} bytes`);
  const tmp = `${target.value.abs}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(tmp, bytes, { mode: 0o600, flag: 'wx' });
    await chmod(tmp, 0o600);
    await rename(tmp, target.value.abs);
  } catch {
    await rm(tmp, { force: true }).catch(() => {});
    return refuse(409, `${path} could not be written — check the checkout's permissions`);
  }
  // Files that read a value from this one follow it; only their directive lines change.
  for (const [rel, text] of rendered.value) {
    if (rel !== path) await writeEnvText(join(root, rel), text).catch(() => {});
  }
  return { ok: true, value: { path, content, version: versionOf(bytes), template: current.value.template } };
}

export async function removeEnvFile(root: string, path: string): Promise<EnvFileResult<null>> {
  const target = await resolveTarget(root, path);
  if (!target.ok) return target;
  if (!target.value.exists) return refuse(404, `${path} does not exist`);
  try {
    await rm(target.value.abs);
  } catch {
    return refuse(409, `${path} could not be removed — check the checkout's permissions`);
  }
  return { ok: true, value: null };
}
