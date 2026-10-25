import { z } from 'zod';
import {
  mcpServerDefinitionSchema,
  secretNameIssue,
  type McpRegistryEntry,
  type McpRegistryResponse,
  type McpServerDefinition,
  type McpServerKey,
} from '@open-mercato/cezar-contract';

/**
 * Search of the official MCP Registry (spec `2026-10-24-easy-mcp` §3): read-only, proxied so the
 * cockpit never talks to a third party, cached an hour per query. Made only when the operator
 * types in the search box (§6). Every result is data from a third party — marked `unreviewed`,
 * added only when the operator picks it, its command shown before Add (§5). Never throws.
 */

export const MCP_REGISTRY_URL = 'https://registry.modelcontextprotocol.io/v0/servers';
const CACHE_TTL_MS = 60 * 60 * 1000;
const CACHE_MAX = 100;
const TIMEOUT_MS = 8000;
const LIMIT = 20;

const variableSchema = z
  .object({
    name: z.string(),
    description: z.string().optional(),
    isRequired: z.boolean().optional(),
    isSecret: z.boolean().optional(),
    value: z.string().optional(),
    default: z.string().optional(),
  })
  .passthrough();

const argumentSchema = z
  .object({
    type: z.string().optional(),
    name: z.string().optional(),
    value: z.string().optional(),
    valueHint: z.string().optional(),
    isRequired: z.boolean().optional(),
  })
  .passthrough();

const packageSchema = z
  .object({
    registryType: z.string().optional(),
    identifier: z.string().optional(),
    version: z.string().optional(),
    transport: z.object({ type: z.string() }).passthrough().optional(),
    packageArguments: z.array(argumentSchema).optional(),
    environmentVariables: z.array(variableSchema).optional(),
  })
  .passthrough();

const remoteSchema = z
  .object({ type: z.string(), url: z.string(), headers: z.array(variableSchema).optional() })
  .passthrough();

const serverSchema = z
  .object({
    name: z.string(),
    title: z.string().optional(),
    description: z.string().optional(),
    version: z.string().optional(),
    websiteUrl: z.string().optional(),
    repository: z.object({ url: z.string().optional() }).passthrough().optional(),
    packages: z.array(packageSchema).optional(),
    remotes: z.array(remoteSchema).optional(),
  })
  .passthrough();

/** Both shapes the registry has served: `{ server, _meta }` items, and bare server objects. */
const responseSchema = z
  .object({ servers: z.array(z.union([z.object({ server: serverSchema }).passthrough(), serverSchema])) })
  .passthrough();

type RegistryServer = z.infer<typeof serverSchema>;

/** `ACME API key` → `ACME_API_KEY`, a valid secret name or null. */
function secretNameOf(text: string): string | null {
  const name = text.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(\d)/, '_$1').slice(0, 128);
  return name && !secretNameIssue(name) ? name : null;
}

/** The server name it is added under: the registry name's last segment, made a valid name. */
export function suggestedNameOf(registryName: string): string {
  const last = registryName.split('/').pop() ?? registryName;
  const cleaned = last.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
  return cleaned || 'server';
}

const ref = (name: string) => `\${{ secrets.${name} }}`;

/** A value template's `{placeholder}`s as secret references, collecting the keys they need. */
function templated(template: string, keys: McpServerKey[], fallback: string, description: string): string | null {
  let failed = false;
  const out = template.replace(/\{([^{}]+)\}/g, (_, inner: string) => {
    const name = secretNameOf(inner) ?? secretNameOf(fallback);
    if (!name) {
      failed = true;
      return '';
    }
    if (!keys.some((key) => key.name === name)) keys.push({ name, description, required: true });
    return ref(name);
  });
  return failed ? null : out;
}

/** One variable (env or header) as a definition value, or null when it is optional and unset. */
function variableValue(variable: z.infer<typeof variableSchema>, keys: McpServerKey[]): string | null {
  const description = variable.description ?? variable.name;
  if (variable.value && /\{[^{}]+\}/.test(variable.value)) return templated(variable.value, keys, variable.name, description);
  if (variable.value && !variable.isSecret) return variable.value;
  if (!variable.isRequired && !variable.isSecret) return null;
  const name = secretNameOf(variable.name);
  if (!name) return null;
  if (!keys.some((key) => key.name === name)) keys.push({ name, description, required: variable.isRequired ?? false });
  return ref(name);
}

const LAUNCHERS: Record<string, (id: string, version?: string) => { command: string; args: string[] }> = {
  npm: (id, version) => ({ command: 'npx', args: ['-y', version ? `${id}@${version}` : id] }),
  pypi: (id, version) => ({ command: 'uvx', args: [version ? `${id}@${version}` : id] }),
  oci: (id, version) => ({ command: 'docker', args: ['run', '-i', '--rm', version && !id.includes(':') ? `${id}:${version}` : id] }),
};

/** A registry server as a definition cezar can launch, and the keys it needs — or null. */
export function definitionOf(server: RegistryServer): { definition: McpServerDefinition; keys: McpServerKey[] } | null {
  for (const pkg of server.packages ?? []) {
    const launch = pkg.registryType ? LAUNCHERS[pkg.registryType] : undefined;
    if (!launch || !pkg.identifier || (pkg.transport && pkg.transport.type !== 'stdio')) continue;
    const keys: McpServerKey[] = [];
    const { command, args } = launch(pkg.identifier, pkg.version);
    const env: Record<string, string> = {};
    for (const variable of pkg.environmentVariables ?? []) {
      const value = variableValue(variable, keys);
      if (value !== null) env[variable.name] = value;
    }
    // A container sees only the variables named with `-e`; docker forwards their values from its own env.
    if (pkg.registryType === 'oci') args.splice(3, 0, ...Object.keys(env).flatMap((name) => ['-e', name]));
    for (const argument of pkg.packageArguments ?? []) {
      if (argument.value !== undefined) {
        args.push(...(argument.type === 'named' && argument.name ? [argument.name, argument.value] : [argument.value]));
      } else if (argument.isRequired) {
        const name = secretNameOf(argument.valueHint ?? argument.name ?? '');
        if (!name) return null;
        if (!keys.some((key) => key.name === name)) keys.push({ name, description: argument.valueHint ?? name, required: true });
        args.push(...(argument.type === 'named' && argument.name ? [argument.name, ref(name)] : [ref(name)]));
      }
    }
    const definition = { command, args, ...(Object.keys(env).length ? { env } : {}) };
    if (mcpServerDefinitionSchema.safeParse(definition).success) return { definition, keys };
  }
  for (const remote of server.remotes ?? []) {
    const type = remote.type === 'streamable-http' ? 'http' : remote.type === 'sse' ? 'sse' : null;
    if (!type) continue;
    const keys: McpServerKey[] = [];
    const headers: Record<string, string> = {};
    for (const header of remote.headers ?? []) {
      const value = variableValue(header, keys);
      if (value !== null) headers[header.name] = value;
    }
    const definition = { type, url: remote.url, ...(Object.keys(headers).length ? { headers } : {}) } as McpServerDefinition;
    if (mcpServerDefinitionSchema.safeParse(definition).success) return { definition, keys };
  }
  return null;
}

/** One registry server as the API describes it. */
export function registryEntryOf(server: RegistryServer): McpRegistryEntry {
  const launch = definitionOf(server);
  const docsUrl = server.websiteUrl ?? server.repository?.url;
  return {
    id: server.name,
    title: server.title ?? server.name,
    description: server.description ?? '',
    ...(server.version ? { version: server.version } : {}),
    ...(docsUrl && /^https?:\/\//.test(docsUrl) ? { docsUrl } : {}),
    suggestedName: suggestedNameOf(server.name),
    definition: launch?.definition ?? null,
    keys: launch?.keys ?? [],
    unreviewed: true,
  };
}

export interface RegistrySearchOptions {
  fetch?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}

/** An hour-long, per-process cache of registry answers. One per server; tests build their own. */
export class McpRegistrySearch {
  private readonly cache = new Map<string, { at: number; response: McpRegistryResponse }>();
  private readonly fetchImpl: typeof fetch;
  private readonly env: NodeJS.ProcessEnv;
  private readonly now: () => number;

  constructor(options: RegistrySearchOptions = {}) {
    this.fetchImpl = options.fetch ?? fetch;
    this.env = options.env ?? process.env;
    this.now = options.now ?? Date.now;
  }

  async search(query: string): Promise<McpRegistryResponse> {
    const q = query.trim().toLowerCase();
    if (this.env.CEZ_DRY_RUN === '1') return { items: [], available: false, reason: 'CEZ_DRY_RUN=1: the MCP Registry is not contacted' };
    const cached = this.cache.get(q);
    if (cached && this.now() - cached.at < CACHE_TTL_MS) return cached.response;
    const response = await this.fetchFresh(q);
    // A failure is not cached: the next keystroke may well find the network back.
    if (response.available) {
      this.cache.delete(q);
      this.cache.set(q, { at: this.now(), response });
      while (this.cache.size > CACHE_MAX) this.cache.delete(this.cache.keys().next().value as string);
    }
    return response;
  }

  private async fetchFresh(q: string): Promise<McpRegistryResponse> {
    const url = `${MCP_REGISTRY_URL}?${new URLSearchParams({ search: q, limit: String(LIMIT) })}`;
    let body: unknown;
    try {
      const res = await this.fetchImpl(url, {
        headers: { accept: 'application/json', 'user-agent': 'cezar' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) return { items: [], available: false, reason: `the MCP Registry answered ${res.status}` };
      body = await res.json();
    } catch (error) {
      return { items: [], available: false, reason: `the MCP Registry could not be reached: ${(error as Error).message}` };
    }
    const parsed = responseSchema.safeParse(body);
    if (!parsed.success) return { items: [], available: false, reason: 'the MCP Registry answered in a shape cezar does not read' };
    const seen = new Set<string>();
    const items: McpRegistryEntry[] = [];
    for (const item of parsed.data.servers) {
      const server: RegistryServer = 'server' in item && item.server && typeof item.server === 'object' ? (item.server as RegistryServer) : (item as RegistryServer);
      // The registry lists every published version; the first one it sends per name is enough here.
      if (seen.has(server.name)) continue;
      seen.add(server.name);
      items.push(registryEntryOf(server));
    }
    return { items, available: true };
  }
}
