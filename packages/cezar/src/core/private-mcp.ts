import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { mcpSecretNames, parseMcpValue, type McpScope, type McpServerReach } from '@open-mercato/cezar-contract';
import { RUNNER_IDS, type RunnerId } from './agent-runner.ts';

/**
 * Private, per-project MCP servers (spec `.ai/specs/2026-10-07-private-project-mcp.md`).
 *
 * One file, `<repo>/.ai/cezar/mcp.local.json`, in the same shape as Claude's `.mcp.json`
 * (`{ "mcpServers": { "<name>": { … } } }`). It lives in cezar's git-ignored data dir — never in
 * a run's worktree — so it cannot be committed by the user or by an agent, and a committed
 * `.mcp.json` next to it is irrelevant. Each runner injects the servers at launch through the
 * agent's own documented channel; nothing is written into the worktree:
 *
 *  - `claude`   — `--mcp-config <0600 temp file>` (additive to the repo's MCP config);
 *  - `codex`    — `thread/start|resume` `config` overrides, one `mcp_servers.<name>` key each;
 *  - `opencode` — `OPENCODE_CONFIG_CONTENT` (loaded after the project config, so it wins) — never a
 *    server holding resolved secrets, since the agent shell inherits that variable;
 *  - `junie`, `copilot` — ACP `session/new|load` `mcpServers`.
 *
 * `cursor` and `pi` have no launch-time MCP channel; a run on them gets a note instead.
 *
 * Pure apart from `loadPrivateMcp`, which never throws: an absent file is "no servers", a broken
 * one is "no servers" plus a problem string the run surfaces as a note.
 */

export const PRIVATE_MCP_FILE = 'mcp.local.json';
/** The committed twin (spec `2026-10-24-easy-mcp`): same shape, secrets as `${{ secrets.X }}` references. */
export const PROJECT_MCP_FILE = 'mcp.json';

/** `<repo>/.ai/cezar/mcp.local.json` */
export function privateMcpPath(repoRoot: string): string {
  return join(repoRoot, '.ai', 'cezar', PRIVATE_MCP_FILE);
}

/** `<repo>/.ai/cezar/mcp.json` — read from the repo root at launch, never from a worktree. */
export function projectMcpPath(repoRoot: string): string {
  return join(repoRoot, '.ai', 'cezar', PROJECT_MCP_FILE);
}

export type PrivateMcpTransport = 'stdio' | 'http' | 'sse';

export interface PrivateMcpServer {
  name: string;
  transport: PrivateMcpTransport;
  /** stdio only. */
  command?: string;
  args: string[];
  env: Record<string, string>;
  /** http/sse only. */
  url?: string;
  headers: Record<string, string>;
  /** Carries resolved `${{ secrets.X }}` values (set at launch) — kept out of any channel the agent's shell inherits. */
  secretBearing?: boolean;
}

/** The runners that can take private MCP servers at launch. */
export const PRIVATE_MCP_RUNNERS: readonly RunnerId[] = ['claude', 'codex', 'opencode', 'junie', 'copilot'];

export function supportsPrivateMcp(runner: string): boolean {
  return (PRIVATE_MCP_RUNNERS as readonly string[]).includes(runner);
}

/** The strictest name rule among the agents (Codex): letters, digits, `_` and `-`. */
const SERVER_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

const stringRecord = z.record(z.string(), z.string());
const httpUrl = z.url({ protocol: /^https?$/ });

const serverSchema = z
  .object({
    type: z.enum(['stdio', 'http', 'sse']).optional(),
    command: z.string().min(1).optional(),
    args: z.array(z.string()).optional(),
    env: stringRecord.optional(),
    // A url holding a `${{ secrets.X }}` reference is checked again once resolved (`resolveMcpSecrets`).
    url: z.union([httpUrl, z.string().regex(/^https?:\/\/.*\$\{\{/i)]).optional(),
    headers: stringRecord.optional(),
  })
  .passthrough();

const fileSchema = z.object({ mcpServers: z.record(z.string(), z.unknown()).optional() }).passthrough();

export interface PrivateMcpLoad {
  servers: PrivateMcpServer[];
  /** One line per server or file that could not be used — surfaced as a run note. */
  problems: string[];
}

/** Parse the private file's text. Bad entries are skipped one by one; one bad server never drops the rest. */
export function parsePrivateMcp(text: string): PrivateMcpLoad {
  return parseMcpFile(text, PRIVATE_MCP_FILE);
}

/** Parse either file's text; `file` names it in the problems. */
export function parseMcpFile(text: string, file: string): PrivateMcpLoad {
  const problems: string[] = [];
  if (text.trim() === '') return { servers: [], problems };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return { servers: [], problems: [`${file} is not valid JSON: ${(err as Error).message}`] };
  }
  const parsedFile = fileSchema.safeParse(raw);
  if (!parsedFile.success) {
    return { servers: [], problems: [`${file} must be an object with an "mcpServers" object`] };
  }
  const servers: PrivateMcpServer[] = [];
  for (const [name, entry] of Object.entries(parsedFile.data.mcpServers ?? {})) {
    if (!SERVER_NAME_RE.test(name)) {
      problems.push(`MCP server "${name}" skipped: names may only use letters, digits, "_" and "-"`);
      continue;
    }
    const parsed = serverSchema.safeParse(entry);
    if (!parsed.success) {
      problems.push(`MCP server "${name}" skipped: ${parsed.error.issues[0]?.message ?? 'invalid entry'}`);
      continue;
    }
    const s = parsed.data;
    const transport: PrivateMcpTransport = s.type ?? (s.command ? 'stdio' : 'http');
    if (transport === 'stdio' && !s.command) {
      problems.push(`MCP server "${name}" skipped: a stdio server needs "command"`);
      continue;
    }
    if (transport !== 'stdio' && !s.url) {
      problems.push(`MCP server "${name}" skipped: an ${transport} server needs "url"`);
      continue;
    }
    servers.push({
      name,
      transport,
      ...(transport === 'stdio' ? { command: s.command } : { url: s.url }),
      args: transport === 'stdio' ? (s.args ?? []) : [],
      env: transport === 'stdio' ? (s.env ?? {}) : {},
      headers: transport === 'stdio' ? {} : (s.headers ?? {}),
    });
  }
  return { servers, problems };
}

async function loadMcpFile(path: string, file: string): Promise<PrivateMcpLoad> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { servers: [], problems: [] };
    return { servers: [], problems: [`${file} could not be read: ${(err as Error).message}`] };
  }
  return parseMcpFile(text, file);
}

/** Read and parse the project's private MCP file. Never throws. */
export function loadPrivateMcp(repoRoot: string): Promise<PrivateMcpLoad> {
  return loadMcpFile(privateMcpPath(repoRoot), PRIVATE_MCP_FILE);
}

/** Read and parse the project's committed MCP file (spec 2026-10-24-easy-mcp). Never throws. */
export function loadProjectMcp(repoRoot: string): Promise<PrivateMcpLoad> {
  return loadMcpFile(projectMcpPath(repoRoot), PROJECT_MCP_FILE);
}

// ---- launch: both files, merged and resolved (spec 2026-10-24-easy-mcp §3) ----------------

/** Every text a server carries, in the order `mcpSecretNames` reads them. */
function referencedSecrets(server: PrivateMcpServer): string[] {
  return mcpSecretNames(
    server.transport === 'stdio'
      ? { command: server.command, args: server.args, env: server.env }
      : { type: server.transport, url: server.url, headers: server.headers },
  );
}

/**
 * `server` with every `${{ secrets.X }}` replaced from `values`, or why it cannot be. A resolved
 * url must still be an http(s) URL. A name absent from `values` is an error: launching with the
 * raw reference would only fail later, with a worse message.
 */
export function resolveMcpSecrets(
  server: PrivateMcpServer,
  values: Readonly<Record<string, string>>,
  why: (name: string) => string = (name) => `secret ${name} is not stored for this project or workspace`,
): PrivateMcpServer | { error: string } {
  let failure: string | null = null;
  const resolve = (text: string): string => {
    const parsed = parseMcpValue(text);
    if ('error' in parsed) {
      failure ??= parsed.error;
      return text;
    }
    return parsed.pieces
      .map((piece) => {
        if (typeof piece === 'string') return piece;
        const value = values[piece.secret];
        if (value === undefined) failure ??= why(piece.secret);
        return value ?? '';
      })
      .join('');
  };
  const record = (input: Record<string, string>) => Object.fromEntries(Object.entries(input).map(([key, value]) => [key, resolve(value)]));
  const next: PrivateMcpServer = {
    ...server,
    ...(server.command ? { command: resolve(server.command) } : {}),
    args: server.args.map(resolve),
    env: record(server.env),
    ...(server.url ? { url: resolve(server.url) } : {}),
    headers: record(server.headers),
  };
  if (failure) return { error: failure };
  if (next.url && !httpUrl.safeParse(next.url).success) return { error: 'its url is not an http(s) URL once its secrets are filled in' };
  return next;
}

export interface LaunchMcpProblem {
  scope: McpScope;
  /** Absent for a file-level problem. */
  name?: string;
  message: string;
}

export interface LaunchMcp {
  /** Ready to inject: project servers, then private ones, a private entry replacing a project one of its name. */
  servers: PrivateMcpServer[];
  /** Which file each server in `servers` came from. */
  scopes: Map<string, McpScope>;
  problems: LaunchMcpProblem[];
  /** The resolved secret values, for the run's redaction list. */
  secretValues: string[];
}

/**
 * Why secret `name` did not resolve: the store's own line for that name, else a store-level line
 * (an unreadable source) said as such — never another secret's line.
 */
export function missingSecretReason(notes: readonly string[], name: string): string {
  const own = notes.find((note) => note.startsWith(`secret ${name} `));
  if (own) return own;
  const storeLevel = notes.filter((note) => !/^secret \S+ /.test(note));
  return storeLevel.length
    ? `secret ${name} could not be read — ${storeLevel.join('; ')}`
    : `secret ${name} is not stored for this project or workspace`;
}

/** What the launch asks the secrets store: the named secrets, audience `cezar`. */
export type McpSecretResolver = (names: string[]) => Promise<{ values: Record<string, string>; notes: string[] }>;

/**
 * Both files for one agent launch. Never throws: a broken file or entry, a missing secret or a
 * failing store each skip what they touch, with a problem the run surfaces as a note.
 */
export async function loadLaunchMcp(repoRoot: string, resolveSecrets: McpSecretResolver): Promise<LaunchMcp> {
  const [project, priv] = await Promise.all([loadProjectMcp(repoRoot), loadPrivateMcp(repoRoot)]);
  const problems: LaunchMcpProblem[] = [
    ...project.problems.map((message) => ({ scope: 'project' as const, message })),
    ...priv.problems.map((message) => ({ scope: 'private' as const, message })),
  ];
  const merged = new Map<string, { server: PrivateMcpServer; scope: McpScope }>();
  for (const server of project.servers) merged.set(server.name, { server, scope: 'project' });
  for (const server of priv.servers) merged.set(server.name, { server, scope: 'private' });

  const names = [...new Set([...merged.values()].flatMap(({ server }) => referencedSecrets(server)))];
  let values: Record<string, string> = {};
  let notes: string[] = [];
  if (names.length > 0) {
    try {
      ({ values, notes } = await resolveSecrets(names));
    } catch (err) {
      notes = [`the secrets store could not be read: ${(err as Error).message}`];
    }
  }
  const noteFor = (name: string) => missingSecretReason(notes, name);

  const servers: PrivateMcpServer[] = [];
  const scopes = new Map<string, McpScope>();
  const used = new Set<string>();
  for (const { server, scope } of merged.values()) {
    const resolved = resolveMcpSecrets(server, values, noteFor);
    if ('error' in resolved) {
      problems.push({ scope, name: server.name, message: `MCP server "${server.name}" skipped: ${resolved.error}` });
      continue;
    }
    const referenced = referencedSecrets(server);
    for (const name of referenced) used.add(name);
    servers.push(referenced.length > 0 ? { ...resolved, secretBearing: true } : resolved);
    scopes.set(server.name, scope);
  }
  const secretValues = [...used].map((name) => values[name]).filter((value): value is string => typeof value === 'string');
  return { servers, scopes, problems, secretValues };
}

/**
 * OpenCode takes launch-time servers only through `OPENCODE_CONFIG_CONTENT`, which every shell
 * the agent runs inherits: a server carrying a resolved secret is never given to it.
 */
export const OPENCODE_SECRETS_NOTE =
  'OpenCode takes launch-time MCP servers only through an env var its shell inherits, so a server with secrets is not given to it';

/**
 * Whether a server of `transport` reaches each runner at launch — the per-agent table of spec
 * 2026-10-07-private-project-mcp, as Settings shows it.
 */
export function mcpReachOf(transport: PrivateMcpTransport, options: { secretBearing?: boolean } = {}): McpServerReach[] {
  return RUNNER_IDS.map((runner): McpServerReach => {
    if (runner === 'opencode' && options.secretBearing) return { runner, reach: 'no', note: OPENCODE_SECRETS_NOTE };
    if (runner === 'cursor') return { runner, reach: 'no', note: 'Cursor Agent CLI reads MCP only from .cursor/mcp.json — no launch-time channel' };
    if (runner === 'pi') return { runner, reach: 'no', note: 'pi has no MCP support' };
    if (runner === 'codex' && transport === 'sse') return { runner, reach: 'no', note: 'Codex speaks stdio and streamable HTTP only' };
    if ((runner === 'junie' || runner === 'copilot') && transport !== 'stdio') {
      return { runner, reach: 'maybe', note: `only when the agent advertises ${transport} MCP in its ACP initialize` };
    }
    return { runner, reach: 'yes' };
  });
}

// ---- per-agent translations ------------------------------------------------

/** Claude `--mcp-config` file contents (the `.mcp.json` shape, normalized). */
export function toClaudeMcpConfig(servers: readonly PrivateMcpServer[]): { mcpServers: Record<string, unknown> } {
  const mcpServers: Record<string, unknown> = {};
  for (const s of servers) {
    mcpServers[s.name] =
      s.transport === 'stdio'
        ? { type: 'stdio', command: s.command, args: s.args, env: s.env }
        : { type: s.transport, url: s.url, headers: s.headers };
  }
  return { mcpServers };
}

/**
 * Claude permission rules that let a headless (`dontAsk`) run call the private servers' tools.
 * `mcp__<server>` matches every tool of that server. The user added the server for this project
 * on purpose, so its tools are allowed like the default built-ins are.
 */
export function claudeMcpAllowRules(servers: readonly PrivateMcpServer[]): string[] {
  return servers.map((s) => `mcp__${s.name}`);
}

/**
 * Codex `thread/start` / `thread/resume` `config` overrides. One dotted key per server so the
 * user's own `[mcp_servers]` table is extended, not replaced. Codex speaks stdio and streamable
 * HTTP only — an `sse` server is returned in `skipped`.
 */
export function toCodexConfigOverrides(servers: readonly PrivateMcpServer[]): {
  config: Record<string, unknown>;
  skipped: string[];
} {
  const config: Record<string, unknown> = {};
  const skipped: string[] = [];
  for (const s of servers) {
    if (s.transport === 'sse') {
      skipped.push(s.name);
      continue;
    }
    config[`mcp_servers.${s.name}`] =
      s.transport === 'stdio'
        ? { command: s.command, args: s.args, ...(Object.keys(s.env).length ? { env: s.env } : {}) }
        : { url: s.url, ...(Object.keys(s.headers).length ? { http_headers: s.headers } : {}) };
  }
  return { config, skipped };
}

/** OpenCode `mcp` entries (`local` = stdio, `remote` = http/sse). */
export function toOpencodeMcp(servers: readonly PrivateMcpServer[]): Record<string, unknown> {
  const mcp: Record<string, unknown> = {};
  for (const s of servers) {
    mcp[s.name] =
      s.transport === 'stdio'
        ? {
            type: 'local',
            command: [s.command, ...s.args],
            ...(Object.keys(s.env).length ? { environment: s.env } : {}),
            enabled: true,
          }
        : { type: 'remote', url: s.url, ...(Object.keys(s.headers).length ? { headers: s.headers } : {}), enabled: true };
  }
  return mcp;
}

/**
 * The `OPENCODE_CONFIG_CONTENT` value for a run: the private servers merged into any inline
 * config the host already passes, so an existing value is extended rather than clobbered.
 */
export function opencodeConfigContent(servers: readonly PrivateMcpServer[], existing?: string): string {
  let base: Record<string, unknown> = {};
  if (existing) {
    try {
      const parsed: unknown = JSON.parse(existing);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) base = parsed as Record<string, unknown>;
    } catch {
      // an unparseable host value cannot be merged into; the private servers still apply
    }
  }
  const baseMcp = base.mcp && typeof base.mcp === 'object' && !Array.isArray(base.mcp) ? base.mcp : {};
  return JSON.stringify({ ...base, mcp: { ...baseMcp, ...toOpencodeMcp(servers) } });
}

/** What an ACP agent advertised in `initialize` → `agentCapabilities.mcpCapabilities`. */
export interface AcpMcpCapabilities {
  http?: boolean;
  sse?: boolean;
}

/** Read `agentCapabilities.mcpCapabilities` out of an ACP `initialize` result. */
export function acpMcpCapabilities(initializeResult: unknown): AcpMcpCapabilities {
  const caps = (initializeResult as { agentCapabilities?: { mcpCapabilities?: unknown } } | null)?.agentCapabilities
    ?.mcpCapabilities;
  if (!caps || typeof caps !== 'object') return {};
  const c = caps as Record<string, unknown>;
  return { http: c.http === true, sse: c.sse === true };
}

/**
 * ACP `mcpServers` for `session/new` / `session/load`. stdio is mandatory for every ACP agent;
 * http and sse only when the agent advertised them — otherwise the server lands in `skipped`.
 */
export function toAcpMcpServers(
  servers: readonly PrivateMcpServer[],
  caps: AcpMcpCapabilities,
): { mcpServers: unknown[]; skipped: string[] } {
  const pairs = (record: Record<string, string>) => Object.entries(record).map(([name, value]) => ({ name, value }));
  const mcpServers: unknown[] = [];
  const skipped: string[] = [];
  for (const s of servers) {
    if (s.transport === 'stdio') {
      mcpServers.push({ name: s.name, command: s.command, args: s.args, env: pairs(s.env) });
    } else if (caps[s.transport]) {
      mcpServers.push({ type: s.transport, name: s.name, url: s.url, headers: pairs(s.headers) });
    } else {
      skipped.push(s.name);
    }
  }
  return { mcpServers, skipped };
}

/** The note a runner emits when some private servers could not be attached. */
export function skippedServersNote(runner: string, skipped: readonly string[], why: string): string {
  return `private MCP: ${runner} cannot attach ${skipped.join(', ')} — ${why}`;
}
