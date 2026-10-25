import { z } from 'zod';
import { secretNameIssue } from './secrets.ts';

/**
 * Settings → MCP servers (spec `2026-10-24-easy-mcp`): the project's committed `.ai/cezar/mcp.json`
 * and its private `.ai/cezar/mcp.local.json` (spec `2026-10-07-private-project-mcp`), both in
 * Claude's `.mcp.json` shape. A value that needs a credential holds a `${{ secrets.NAME }}`
 * reference, resolved at launch from the project secrets store (audience `cezar`) — never the value.
 */

/** The strictest server-name rule among the agents (Codex): letters, digits, `_` and `-`. */
export const MCP_SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
export const mcpServerNameSchema = z.string().regex(MCP_SERVER_NAME_PATTERN, 'a name is 1–64 letters, digits, "_" or "-"');

/** `project` = `.ai/cezar/mcp.json` (committed), `private` = `.ai/cezar/mcp.local.json` (git-ignored). */
export const MCP_SCOPES = ['project', 'private'] as const;
export const mcpScopeSchema = z.enum(MCP_SCOPES);
export type McpScope = z.infer<typeof mcpScopeSchema>;

export const MCP_TRANSPORTS = ['stdio', 'http', 'sse'] as const;
export const mcpTransportSchema = z.enum(MCP_TRANSPORTS);
export type McpTransport = z.infer<typeof mcpTransportSchema>;

/** `${{ secrets.NAME }}` — the one reference an MCP definition may hold. `\${{` is a literal `${{`. */
export function mcpSecretReference(name: string): string {
  return `\${{ secrets.${name} }}`;
}

const REFERENCE_BODY = /^\s*secrets\.([A-Za-z0-9_]+)\s*$/;

/** Literal text and secret references of one string, or the reason it is not one. */
export function parseMcpValue(text: string): { pieces: Array<string | { secret: string }> } | { error: string } {
  const pieces: Array<string | { secret: string }> = [];
  let literal = '';
  for (let i = 0; i < text.length;) {
    if (text.startsWith('\\${{', i)) { literal += '${{'; i += 4; continue; }
    if (text.startsWith('${{', i)) {
      const end = text.indexOf('}}', i + 3);
      if (end < 0) return { error: `close the reference at position ${i + 1} with }}` };
      const body = REFERENCE_BODY.exec(text.slice(i + 3, end));
      if (!body) return { error: `only \${{ secrets.NAME }} references are allowed, not \${{${text.slice(i + 3, end)}}}` };
      const issue = secretNameIssue(body[1]!);
      if (issue) return { error: `secrets.${body[1]}: ${issue}` };
      if (literal) pieces.push(literal);
      literal = '';
      pieces.push({ secret: body[1]! });
      i = end + 2;
      continue;
    }
    literal += text[i];
    i += 1;
  }
  if (literal) pieces.push(literal);
  return { pieces };
}

/** Whether a string carries at least one secret reference. */
export function hasMcpSecretReference(text: string): boolean {
  const parsed = parseMcpValue(text);
  return 'pieces' in parsed && parsed.pieces.some((piece) => typeof piece !== 'string');
}

const stringRecord = z.record(z.string().min(1).regex(/^[^=\0]+$/, 'a key has no "=" or NUL'), z.string());

/**
 * One server, as the file stores it. `type` omitted: `command` means stdio and `url` means http.
 * Strict, so a typo'd key is a 400 naming it rather than a definition that silently does less.
 */
export const mcpServerDefinitionSchema = z
  .object({
    type: mcpTransportSchema.optional(),
    command: z.string().min(1).optional(),
    args: z.array(z.string()).optional(),
    env: stringRecord.optional(),
    url: z.string().regex(/^https?:\/\//i, 'a url starts with http:// or https://').optional(),
    headers: stringRecord.optional(),
  })
  .strict()
  .superRefine((def, ctx) => {
    const transport = def.type ?? (def.command ? 'stdio' : 'http');
    if (transport === 'stdio' && !def.command) ctx.addIssue({ code: 'custom', message: 'a stdio server needs "command"', path: ['command'] });
    if (transport !== 'stdio' && !def.url) ctx.addIssue({ code: 'custom', message: `an ${transport} server needs "url"`, path: ['url'] });
    if (transport === 'stdio' && (def.url || def.headers)) ctx.addIssue({ code: 'custom', message: 'a stdio server takes command, args and env — not url or headers', path: ['url'] });
    if (transport !== 'stdio' && (def.command || def.args || def.env)) ctx.addIssue({ code: 'custom', message: `an ${transport} server takes url and headers — not command, args or env`, path: ['command'] });
    const check = (value: string, path: (string | number)[]) => {
      const parsed = parseMcpValue(value);
      if ('error' in parsed) ctx.addIssue({ code: 'custom', message: parsed.error, path });
    };
    if (def.command) check(def.command, ['command']);
    def.args?.forEach((arg, index) => check(arg, ['args', index]));
    for (const [key, value] of Object.entries(def.env ?? {})) check(value, ['env', key]);
    if (def.url) check(def.url, ['url']);
    for (const [key, value] of Object.entries(def.headers ?? {})) check(value, ['headers', key]);
  });
export type McpServerDefinition = z.infer<typeof mcpServerDefinitionSchema>;

/**
 * Why `def` may not go into the committed `mcp.json`: an env or header value with no secret
 * reference is a literal, and in a committed file a literal there is a pasted credential waiting
 * to be pushed. Null when every such value is (or holds) a reference.
 */
export function mcpProjectLiteralIssue(def: McpServerDefinition): string | null {
  const literal = (record: Record<string, string> | undefined) => Object.entries(record ?? {}).find(([, value]) => !hasMcpSecretReference(value))?.[0];
  const env = literal(def.env);
  const header = literal(def.headers);
  const where = env !== undefined ? `env ${env}` : header !== undefined ? `header ${header}` : null;
  return where
    ? `${where} holds a literal value: the project file is committed, so use a secret reference (\${{ secrets.NAME }}) — or add the server as Private`
    : null;
}

/** The transport a definition speaks. */
export function mcpTransportOf(def: McpServerDefinition): McpTransport {
  return def.type ?? (def.command ? 'stdio' : 'http');
}

/** Every secret a definition references, deduplicated, in order of appearance. */
export function mcpSecretNames(def: McpServerDefinition): string[] {
  const names: string[] = [];
  const texts = [def.command ?? '', ...(def.args ?? []), ...Object.values(def.env ?? {}), def.url ?? '', ...Object.values(def.headers ?? {})];
  for (const text of texts) {
    const parsed = parseMcpValue(text);
    if (!('pieces' in parsed)) continue;
    for (const piece of parsed.pieces) if (typeof piece !== 'string' && !names.includes(piece.secret)) names.push(piece.secret);
  }
  return names;
}

/** A key a catalog or registry entry needs, always stored as a project secret and referenced. */
export const mcpServerKeySchema = z.object({
  name: z.string(),
  description: z.string(),
  required: z.boolean(),
});
export type McpServerKey = z.infer<typeof mcpServerKeySchema>;

/** One curated catalog entry (`packages/cezar/src/mcp-catalog/`), reviewed by cezar's maintainers. */
export const mcpCatalogEntrySchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  docsUrl: z.string(),
  /** The server name it is added under unless the operator picks another. */
  suggestedName: z.string(),
  definition: mcpServerDefinitionSchema,
  keys: z.array(mcpServerKeySchema),
  /** Signs in with an OAuth browser round trip the first time — a headless run may not finish it (spec §7). */
  oauth: z.boolean().optional(),
});
export type McpCatalogEntry = z.infer<typeof mcpCatalogEntrySchema>;

/** One environment variable or header of a listed server. `value` is null for a literal (never served). */
export const mcpServerValueSchema = z.object({ key: z.string(), value: z.string().nullable() });
export type McpServerValue = z.infer<typeof mcpServerValueSchema>;

/** Whether a server reaches one runner at launch, and why not. */
export const mcpServerReachSchema = z.object({
  runner: z.string(),
  reach: z.enum(['yes', 'no', 'maybe']),
  note: z.string().optional(),
});
export type McpServerReach = z.infer<typeof mcpServerReachSchema>;

/** The last launch that read this server: attached, or not and why (the run's note). */
export const mcpServerStatusSchema = z.object({
  state: z.enum(['injected', 'failed']),
  at: z.string(),
  runId: z.string(),
  runner: z.string(),
  reason: z.string().optional(),
});
export type McpServerStatus = z.infer<typeof mcpServerStatusSchema>;

/** One listed server. Literal env and header values are never served — only references are. */
export const mcpServerSchema = z.object({
  name: z.string(),
  scope: mcpScopeSchema,
  transport: mcpTransportSchema,
  command: z.string().optional(),
  args: z.array(z.string()),
  url: z.string().optional(),
  env: z.array(mcpServerValueSchema),
  headers: z.array(mcpServerValueSchema),
  /** Secret names the definition references. */
  secrets: z.array(z.string()),
  /** Referenced secrets the launch could not resolve: not stored, or not readable by `cezar`. */
  missingSecrets: z.array(z.string()),
  /** A project server a private one of the same name replaces at launch. */
  shadowed: z.boolean(),
  reach: z.array(mcpServerReachSchema),
  status: mcpServerStatusSchema.optional(),
  /** Project servers only: the referenced secrets the operator's approval binds to it — the only ones it receives. */
  boundSecrets: z.array(z.string()).optional(),
});
export type McpServer = z.infer<typeof mcpServerSchema>;

/** One server entry that differs from the approved content; `before`/`after` are redacted JSON. */
export const mcpApprovalChangeSchema = z.object({
  name: z.string(),
  change: z.enum(['added', 'removed', 'changed']),
  before: z.string().optional(),
  after: z.string().optional(),
});
export type McpApprovalChange = z.infer<typeof mcpApprovalChangeSchema>;

/** Secret names bound per project server at approval: `{ server: [names] }`. */
export const mcpSecretBindingsSchema = z.record(mcpServerNameSchema, z.array(z.string()));
export type McpSecretBindings = z.infer<typeof mcpSecretBindingsSchema>;

/**
 * Whether the committed `mcp.json` content was approved on this machine (spec 2026-10-24-easy-mcp
 * §5). `none` = no file or no servers; `unapproved` = never approved; `changed` = it differs from
 * what was approved. Only `approved` content is injected, each server with its bound secrets only.
 */
export const mcpProjectApprovalSchema = z.object({
  state: z.enum(['none', 'approved', 'unapproved', 'changed']),
  /** The current file content's hash — what an approval names. Null without a file. */
  hash: z.string().nullable(),
  approvedAt: z.string().optional(),
  /** Every server entry that differs from the approved content (all of them when never approved). */
  changes: z.array(mcpApprovalChangeSchema),
  /** The last approval's bindings, to pre-fill a review. */
  bindings: mcpSecretBindingsSchema,
});
export type McpProjectApproval = z.infer<typeof mcpProjectApprovalSchema>;

/** `GET /mcp-servers`: both lists, the problems that skipped an entry, and the curated catalog. */
export const mcpServersListSchema = z.object({
  project: z.array(mcpServerSchema),
  private: z.array(mcpServerSchema),
  problems: z.object({ project: z.array(z.string()), private: z.array(z.string()) }),
  catalog: z.array(mcpCatalogEntrySchema),
  /** Whether this cockpit lets the caller write and Test (a trusted operator). */
  editable: z.boolean(),
  approval: mcpProjectApprovalSchema,
});
export type McpServersList = z.infer<typeof mcpServersListSchema>;

/** `POST /mcp-servers/approval`: approve the reviewed content (by its hash) with these bindings. */
export const mcpProjectApproveSchema = z
  .object({ hash: z.string().regex(/^[0-9a-f]{64}$/, 'the content hash the listing served'), bindings: mcpSecretBindingsSchema })
  .strict();
export type McpProjectApprove = z.infer<typeof mcpProjectApproveSchema>;

export const mcpServerParamsSchema = z.object({ scope: mcpScopeSchema, name: mcpServerNameSchema });
export type McpServerParams = z.infer<typeof mcpServerParamsSchema>;

/** `PUT /mcp-servers/:scope/:name`: the definition to store under that name (replacing one). */
export const mcpServerPutSchema = z.object({ definition: mcpServerDefinitionSchema }).strict();
export type McpServerPut = z.infer<typeof mcpServerPutSchema>;

/** `POST /mcp-servers/:scope/:name/test`: the server's tool names, or why it did not answer. */
export const mcpServerTestResponseSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), tools: z.array(z.string()) }),
  z.object({ ok: z.literal(false), reason: z.string() }),
]);
export type McpServerTestResponse = z.infer<typeof mcpServerTestResponseSchema>;

export const mcpRegistryQuerySchema = z.object({ q: z.string().trim().min(1).max(100) });
export type McpRegistryQuery = z.infer<typeof mcpRegistryQuerySchema>;

/** One MCP Registry result, translated into a definition where cezar understands its package. */
export const mcpRegistryEntrySchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  version: z.string().optional(),
  docsUrl: z.string().optional(),
  suggestedName: z.string(),
  /** Null when the entry names no package or remote cezar can launch. */
  definition: mcpServerDefinitionSchema.nullable(),
  keys: z.array(mcpServerKeySchema),
  /** Registry entries are data from a third party: never reviewed by cezar. */
  unreviewed: z.literal(true),
});
export type McpRegistryEntry = z.infer<typeof mcpRegistryEntrySchema>;

/** `GET /mcp-servers/registry?q=`: proxied, cached an hour. `available: false` when it could not answer. */
export const mcpRegistryResponseSchema = z.object({
  items: z.array(mcpRegistryEntrySchema),
  available: z.boolean(),
  reason: z.string().optional(),
});
export type McpRegistryResponse = z.infer<typeof mcpRegistryResponseSchema>;

export const mcpServersErrorSchema = z.object({ error: z.string() }).strict();
export type McpServersErrorResponse = z.infer<typeof mcpServersErrorSchema>;
