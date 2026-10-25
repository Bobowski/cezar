import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import {
  maskMcpValue,
  type McpApprovalChange,
  type McpProjectApproval,
  type McpSecretBindings,
} from '@open-mercato/cezar-contract';
import {
  loadPrivateMcp,
  parseMcpFile,
  PROJECT_MCP_FILE,
  readProjectMcpText,
  referencedSecrets,
  type PrivateMcpServer,
  type PrivateOverrideGate,
  type ProjectMcpGate,
} from '../core/private-mcp.ts';
import { renameWithRetry } from '../fs-rename.ts';
import { assertCezarHomeWriteIsSandboxed, mcpApprovalsPath } from '../paths.ts';
import { LifecycleConflictError, withLifecycleFileLock } from '../worktree-lifecycle/store.ts';
import { redactMcpArgs, redactMcpUrl } from './redact.ts';

/**
 * Approval of the committed `.ai/cezar/mcp.json` (spec `2026-10-24-easy-mcp` §5), mirroring
 * Claude's own `.mcp.json` trust prompt: the file is repo content, so nothing in it runs or
 * receives a secret until the operator approved THAT content on THIS machine. An approval names the
 * file's content hash and, per server, the secret names it may receive; any change to the file
 * drops it. It lives in `~/.cezar/mcp-approvals.json` (`mcpApprovalsPath`), out of every repo, so
 * no commit, pull or auto-sync fast-forward can approve anything — only the operator's click
 * (`approveProjectMcp`) or their own Settings write (`carryProjectApproval`) records one.
 */

export function mcpContentHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

const recordSchema = z.object({
  hash: z.string(),
  approvedAt: z.string(),
  /** The approved `mcpServers` entries, for the review diff. */
  servers: z.record(z.string(), z.unknown()),
  bindings: z.record(z.string(), z.array(z.string())),
});
type ApprovalRecord = z.infer<typeof recordSchema>;

const fileSchema = z
  .object({
    projects: z.record(z.string(), recordSchema.optional().catch(undefined)).catch({}),
    /** Per checkout: private server name → the hash of the entry the operator confirmed as an approved project server's replacement. */
    overrides: z.record(z.string(), z.record(z.string(), z.string()).catch({})).optional().catch(undefined),
  })
  .passthrough()
  .catch({ projects: {} });
type ApprovalsFile = z.infer<typeof fileSchema>;

/** One key per checkout, as the OS compares paths. */
function projectKey(repoRoot: string): string {
  const path = resolve(repoRoot);
  return process.platform === 'win32' ? path.toLowerCase() : path;
}

async function readAll(path = mcpApprovalsPath()): Promise<ApprovalsFile> {
  try {
    return fileSchema.parse(JSON.parse(await readFile(path, 'utf8')));
  } catch {
    return { projects: {} };
  }
}

/** The approval recorded for this checkout, if any. Never throws. */
export async function readProjectApproval(repoRoot: string): Promise<ApprovalRecord | undefined> {
  return (await readAll()).projects[projectKey(repoRoot)] ?? undefined;
}

let queue: Promise<unknown> = Promise.resolve();

/** Why a write was refused: another process holds the approvals lock past the wait. */
export const APPROVALS_BUSY = 'another cezar process is writing MCP approvals — try again';

/**
 * Read-modify-write of the approvals file: one at a time in this process, and across processes
 * under the mkdir + PID-owner lock (`withLifecycleFileLock`) — contention past its wait throws, so
 * nothing is approved on a write that lost; `0600`, atomic. `change` returns false to write nothing.
 */
function mutateAll(change: (all: ApprovalsFile) => boolean | void): Promise<void> {
  const next = queue.then(async () => {
    const path = mcpApprovalsPath();
    assertCezarHomeWriteIsSandboxed(path);
    await withLifecycleFileLock(`${path}.lock`, async () => {
      const all = await readAll(path);
      if (change(all) === false) return;
      const tmp = `${path}.${process.pid}-${randomUUID()}.tmp`;
      await writeFile(tmp, `${JSON.stringify(all, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      await renameWithRetry(tmp, path);
    }).catch((error: unknown) => {
      throw error instanceof LifecycleConflictError ? new Error(APPROVALS_BUSY) : error;
    });
  });
  queue = next.catch(() => {});
  return next;
}

function writeRecord(repoRoot: string, record: ApprovalRecord): Promise<void> {
  return mutateAll((all) => {
    all.projects[projectKey(repoRoot)] = record;
  });
}

// ---- a private server replacing an approved project server of its name ---------------------

/** What a replacement confirmation names: the private entry as it launches, so any edit asks again. */
export function privateOverrideHash(server: PrivateMcpServer): string {
  const { name: _name, secretBearing: _bearing, ...entry } = server;
  return mcpContentHash(canonical(entry));
}

/** The launch's `privateOverride`: this exact private entry was confirmed here. Never throws. */
export const privateOverrideGate = (repoRoot: string): PrivateOverrideGate => async (server) =>
  (await readAll()).overrides?.[projectKey(repoRoot)]?.[server.name] === privateOverrideHash(server);

/** The private entries the operator confirmed, by name → hash. Never throws. */
export async function readPrivateOverrides(repoRoot: string): Promise<Record<string, string>> {
  return (await readAll()).overrides?.[projectKey(repoRoot)] ?? {};
}

/**
 * The operator's Confirm (`POST /mcp-servers/override`): the private entry they saw, named by its
 * hash, replaces the approved project server of its name at launch.
 */
export async function confirmPrivateOverride(repoRoot: string, name: string, hash: string): Promise<ApprovalWrite> {
  const server = (await loadPrivateMcp(repoRoot)).servers.find((entry) => entry.name === name);
  if (!server) return { ok: false, status: 404, error: `there is no private MCP server "${name}"` };
  if (privateOverrideHash(server) !== hash) return { ok: false, status: 409, error: `private MCP server "${name}" changed since it was shown — review it again` };
  try {
    await mutateAll((all) => {
      const key = projectKey(repoRoot);
      all.overrides = { ...all.overrides, [key]: { ...all.overrides?.[key], [name]: hash } };
    });
  } catch (error) {
    return { ok: false, status: 409, error: `the confirmation could not be saved: ${(error as Error).message}` };
  }
  return { ok: true };
}

/** The raw `mcpServers` object of a file's text; `{}` when there is none. */
function serversOf(text: string | null): Record<string, unknown> {
  if (!text?.trim()) return {};
  try {
    const parsed = JSON.parse(text) as { mcpServers?: unknown };
    const servers = parsed?.mcpServers;
    return servers && typeof servers === 'object' && !Array.isArray(servers) ? (servers as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** The launch gate (`loadLaunchMcp`'s `projectGate`): this exact text approved here, and with which bindings. */
export const projectMcpGate = (repoRoot: string): ProjectMcpGate => async (text) => {
  const record = await readProjectApproval(repoRoot);
  if (record && record.hash === mcpContentHash(text)) return { approved: true, bindings: record.bindings };
  return {
    approved: false,
    reason: record
      ? `${PROJECT_MCP_FILE} changed since it was approved on this machine — review and approve it in Settings → MCP servers`
      : `${PROJECT_MCP_FILE} is not approved on this machine — review and approve it in Settings → MCP servers`,
  };
};

export type ApprovalWrite = { ok: true } | { ok: false; status: 400 | 404 | 409; error: string };

/** Each binding names a server of `text` and only secrets that server references. */
function bindingIssue(text: string, bindings: McpSecretBindings): string | null {
  const { servers } = parseMcpFile(text, PROJECT_MCP_FILE);
  for (const [name, names] of Object.entries(bindings)) {
    const server = servers.find((entry) => entry.name === name);
    if (!server) return `there is no project MCP server "${name}" to bind secrets to`;
    const referenced = referencedSecrets(server);
    const stray = names.find((secret) => !referenced.includes(secret));
    if (stray) return `MCP server "${name}" does not reference secret ${stray}`;
  }
  return null;
}

const tidy = (bindings: McpSecretBindings): McpSecretBindings =>
  Object.fromEntries(Object.entries(bindings).filter(([, names]) => names.length > 0).map(([name, names]) => [name, [...new Set(names)].sort()]));

/**
 * The operator's Approve (`POST /mcp-servers/approval`): the content they reviewed, named by its
 * hash so a file that changed since is refused rather than approved unseen.
 */
export async function approveProjectMcp(repoRoot: string, hash: string, bindings: McpSecretBindings): Promise<ApprovalWrite> {
  const text = await readProjectMcpText(repoRoot);
  if (text === null) return { ok: false, status: 404, error: `there is no .ai/cezar/${PROJECT_MCP_FILE} to approve` };
  if (mcpContentHash(text) !== hash) return { ok: false, status: 409, error: `${PROJECT_MCP_FILE} changed since it was shown — review it again` };
  const issue = bindingIssue(text, bindings);
  if (issue) return { ok: false, status: 400, error: issue };
  try {
    await writeRecord(repoRoot, { hash, approvedAt: new Date().toISOString(), servers: serversOf(text), bindings: tidy(bindings) });
  } catch (error) {
    return { ok: false, status: 409, error: `the approval could not be saved: ${(error as Error).message}` };
  }
  return { ok: true };
}

/** What one Settings write did to the file's servers. */
export type ApprovalCarry = { bind: string; names: string[] } | { unbind: string };

/**
 * After the operator's own Settings write of the project file: when the content before it was
 * approved (or empty), the new content is approved too, carrying the other servers' bindings and
 * binding the written entry's own references (the operator just picked them). A file still
 * awaiting review stays awaiting it — a write never approves content nobody looked at.
 */
export async function carryProjectApproval(repoRoot: string, before: string | null, after: string, carry: ApprovalCarry): Promise<void> {
  const wasEmpty = Object.keys(serversOf(before)).length === 0;
  // Decided under the lock: another process's approval between read and write is seen, not lost.
  await mutateAll((all) => {
    const key = projectKey(repoRoot);
    const record = all.projects[key];
    if (!wasEmpty && record?.hash !== mcpContentHash(before ?? '')) return false;
    const bindings: McpSecretBindings = { ...(wasEmpty ? {} : record?.bindings) };
    if ('bind' in carry) bindings[carry.bind] = carry.names;
    else delete bindings[carry.unbind];
    all.projects[key] = { hash: mcpContentHash(after), approvedAt: new Date().toISOString(), servers: serversOf(after), bindings: tidy(bindings) };
  });
}

// ---- the review: state and a redacted diff of the server entries ---------------------------

/** JSON with sorted keys, so an entry's key order is not a change. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

const LITERAL_HIDDEN = '[literal value hidden]';

/** An entry as the review shows it: literal env/header values, credential args and url parts masked unless `raw`. */
function displayEntry(entry: unknown, raw: boolean): string {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return JSON.stringify(entry);
  const shown: Record<string, unknown> = { ...(entry as Record<string, unknown>) };
  if (!raw) {
    if (typeof shown.command === 'string') shown.command = redactMcpUrl(shown.command);
    if (Array.isArray(shown.args)) shown.args = redactMcpArgs(shown.args.map(String));
    if (typeof shown.url === 'string') shown.url = redactMcpUrl(shown.url);
    for (const key of ['env', 'headers'] as const) {
      const record = shown[key];
      if (record && typeof record === 'object' && !Array.isArray(record)) {
        shown[key] = Object.fromEntries(
          Object.entries(record).map(([name, value]) => [name, (typeof value === 'string' ? maskMcpValue(value) : null) ?? LITERAL_HIDDEN]),
        );
      }
    }
  }
  return JSON.stringify(shown, null, 2);
}

/** Every entry of `current` that differs from `approved`. */
function changesBetween(approved: Record<string, unknown>, current: Record<string, unknown>, raw: boolean): McpApprovalChange[] {
  const changes: McpApprovalChange[] = [];
  for (const name of new Set([...Object.keys(approved), ...Object.keys(current)])) {
    const was = Object.hasOwn(approved, name);
    const is = Object.hasOwn(current, name);
    if (was && is && canonical(approved[name]) === canonical(current[name])) continue;
    changes.push({
      name,
      change: !was ? 'added' : !is ? 'removed' : 'changed',
      ...(was ? { before: displayEntry(approved[name], raw) } : {}),
      ...(is ? { after: displayEntry(current[name], raw) } : {}),
    });
  }
  return changes;
}

/** What Settings shows of the committed file's approval. Never throws. */
export async function projectApprovalView(repoRoot: string, options: { raw: boolean }): Promise<McpProjectApproval> {
  const [text, record] = await Promise.all([readProjectMcpText(repoRoot), readProjectApproval(repoRoot)]);
  const current = serversOf(text);
  const hash = text === null ? null : mcpContentHash(text);
  const bindings = record?.bindings ?? {};
  if (Object.keys(current).length === 0) return { state: 'none', hash, changes: [], bindings };
  if (record && record.hash === hash) return { state: 'approved', hash, approvedAt: record.approvedAt, changes: [], bindings };
  return {
    state: record ? 'changed' : 'unapproved',
    hash,
    ...(record ? { approvedAt: record.approvedAt } : {}),
    changes: changesBetween(record?.servers ?? {}, current, options.raw),
    bindings,
  };
}
