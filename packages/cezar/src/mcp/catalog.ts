import { z } from 'zod';
import { routeContractOf, routeContracts, type RouteContract } from '@open-mercato/cezar-contract';
import { routeInputOf, type RouteInput } from '../server/validators.ts';

/**
 * The MCP tool catalog, generated from the app's own route table (spec
 * 2026-10-24-cezar-mcp-server §3): one tool per `/api/v1` route, its input the route's
 * validators (path params + query + body), its output the route-table `response`. Nothing here
 * is hand-written per route except what `packages/contract/src/routes.ts` says.
 */

type JsonSchema = Record<string, unknown>;

/** One row of `app.routes` — every handler of a route, middleware included. */
export interface RouteRow {
  method: string;
  path: string;
  handler: unknown;
}

export interface CatalogTool {
  name: string;
  description: string;
  method: string;
  /** Relative to `/api/v1`, unscoped: `/runs/:id`. */
  path: string;
  /** Mounted under `/api/v1/p/:projectId` too, so the tool takes a `projectId`. */
  scoped: boolean;
  set: string;
  params: string[];
  query: string[];
  /** `flat`: the body's properties sit beside params and query; `nested`: under `body`. */
  body: 'none' | 'flat' | 'nested';
  bodyKeys: string[];
  inputSchema: JsonSchema;
  outputSchema?: JsonSchema;
  /** The response is not an object, so it travels as `{ result }`. */
  outputWrapped: boolean;
  annotations: { title: string; readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean };
}

export interface Catalog {
  tools: CatalogTool[];
  byName: Map<string, CatalogTool>;
}

/** What the generator could not reconcile. Both lists empty is the build's rule (`catalog.test.ts`). */
export interface CatalogProblems {
  /** Served routes with no route-table entry. */
  missing: string[];
  /** Route-table entries the app does not serve. */
  stale: string[];
}

/** The set each family's tools fall in; a family not listed is its own set. */
const FAMILY_SETS: Record<string, string> = {
  runs: 'runs',
  groups: 'runs',
  todos: 'runs',
  'workspace/uploads': 'runs',
  workflows: 'workflows',
  plan: 'workflows',
  skills: 'skills',
  projects: 'projects',
  fs: 'projects',
  repo: 'repo',
  worktrees: 'repo',
  'worktree-lifecycle': 'repo',
  github: 'github',
  automations: 'automations',
  'automation-log': 'automations',
  'automation-checks': 'automations',
  'workspace/automation-templates': 'automations',
  tracker: 'tracker',
  services: 'services',
  docker: 'services',
  e2e: 'services',
  'start-app': 'services',
  preview: 'services',
  'env-files': 'env',
  secrets: 'env',
  'workspace/secrets': 'env',
  config: 'settings',
  'agent-config': 'settings',
  'ui-state': 'settings',
  'launch-key': 'settings',
  'open-in': 'settings',
  'open-targets': 'settings',
  models: 'settings',
  providers: 'settings',
  health: 'settings',
  'star-count': 'settings',
  telemetry: 'settings',
};

/** What a client gets without `?tools=` / `--tools` — about thirty tools. */
export const DEFAULT_TOOL_SETS = ['tasks', 'workflows', 'skills', 'projects'] as const;

/** Families whose tools reach past this machine (GitHub, the issue tracker). */
const OPEN_WORLD = new Set(['github', 'tracker']);

const API = '/api/v1';
const SCOPED = `${API}/p/:projectId`;

function familyOf(path: string): string {
  const [first = '', second] = path.split('/').filter(Boolean);
  return first === 'workspace' && second ? `workspace/${second}` : first;
}

export function setOf(path: string, entry: RouteContract): string {
  if (entry.set) return entry.set;
  const family = familyOf(path);
  return FAMILY_SETS[family] ?? (family.startsWith('workspace/') ? 'workspace' : family);
}

/**
 * `<family>_<words>[_verb]` from the path: GET lists or reads, POST on a collection creates and
 * on anything else is the action it names, PUT/PATCH/DELETE say so. `tool` in the route table
 * overrides a name that reads badly.
 */
export function toolNameOf(method: string, path: string, entry: RouteContract, collections: ReadonlySet<string>): string {
  if (entry.tool) return entry.tool;
  const segments = path.split('/').filter(Boolean);
  const words = segments.slice(1).filter((segment) => !segment.startsWith(':'));
  const endsWithParam = segments[segments.length - 1]?.startsWith(':') ?? false;
  let verb: string[];
  switch (method) {
    case 'GET':
      verb = words.length === 0 ? [endsWithParam ? 'get' : 'list'] : endsWithParam ? [...words, 'get'] : words;
      break;
    case 'POST':
      if (endsWithParam) verb = [...words, 'post'];
      else if (words.length === 0 || collections.has(path)) verb = [...words, 'create'];
      else verb = words;
      break;
    case 'PUT':
      verb = [...words, 'put'];
      break;
    case 'PATCH':
      verb = [...words, 'update'];
      break;
    case 'DELETE':
      verb = [...words, 'delete'];
      break;
    default:
      verb = [...words, method.toLowerCase()];
  }
  return [segments[0] ?? 'api', ...verb].join('_').replace(/[^a-z0-9]+/gi, '_').toLowerCase();
}

/** zod → JSON Schema for one side of the wire; a schema zod cannot express becomes `{}`. */
export function jsonSchemaOf(schema: z.ZodType, io: 'input' | 'output'): JsonSchema {
  const converted = z.toJSONSchema(schema, { io, unrepresentable: 'any' }) as JsonSchema;
  delete converted.$schema;
  return converted;
}

function resolve(input: RouteInput): z.ZodType {
  return typeof input.schema === 'function' ? input.schema() : input.schema;
}

interface Collected {
  method: string;
  path: string;
  scoped: boolean;
  inputs: Map<RouteInput['target'], RouteInput>;
}

/** Group `app.routes` by `METHOD /path` (unscoped), keeping each route's validators. */
function collect(routes: readonly RouteRow[]): Map<string, Collected> {
  const byKey = new Map<string, Collected>();
  for (const route of routes) {
    if (route.method === 'ALL' || !route.path.startsWith(`${API}/`)) continue;
    const scoped = route.path.startsWith(`${SCOPED}/`);
    const path = scoped ? route.path.slice(SCOPED.length) : route.path.slice(API.length);
    const key = `${route.method} ${path}`;
    const row = byKey.get(key) ?? { method: route.method, path, scoped: false, inputs: new Map() };
    row.scoped ||= scoped;
    const input = routeInputOf(route.handler);
    if (input && !row.inputs.has(input.target)) row.inputs.set(input.target, input);
    byKey.set(key, row);
  }
  return byKey;
}

function objectParts(schema: JsonSchema): { properties: Record<string, JsonSchema>; required: string[] } | null {
  if (schema.type !== 'object' || typeof schema.properties !== 'object' || schema.properties === null) return null;
  return {
    properties: schema.properties as Record<string, JsonSchema>,
    required: Array.isArray(schema.required) ? (schema.required as string[]) : [],
  };
}

function hoistDefs(target: JsonSchema, from: JsonSchema): boolean {
  const defs = from.$defs as Record<string, unknown> | undefined;
  if (!defs) return true;
  const into = (target.$defs ??= {}) as Record<string, unknown>;
  for (const [name, def] of Object.entries(defs)) {
    if (name in into) return false;
    into[name] = def;
  }
  delete from.$defs;
  return true;
}

const PROJECT_ID_SCHEMA: JsonSchema = {
  type: 'string',
  description: 'The project, as an id from projects_list. Omit for the project the cockpit was started in.',
};

function buildTool(row: Collected, entry: RouteContract, collections: ReadonlySet<string>): CatalogTool {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  const root: JsonSchema = { type: 'object', properties, required };

  // Path params: the validator's schema when there is one, else a plain string per `:name`.
  const pathParams = row.path.split('/').filter((segment) => segment.startsWith(':')).map((segment) => segment.slice(1));
  const paramInput = row.inputs.get('param');
  const paramSchema = paramInput ? objectParts(jsonSchemaOf(resolve(paramInput), 'input')) : null;
  for (const name of pathParams) {
    properties[name] = paramSchema?.properties[name] ?? { type: 'string' };
    required.push(name);
  }

  const queryKeys: string[] = [];
  const queryInput = row.inputs.get('query');
  if (queryInput) {
    const query = jsonSchemaOf(resolve(queryInput), 'input');
    const parts = objectParts(query);
    if (parts && hoistDefs(root, query)) {
      for (const [name, schema] of Object.entries(parts.properties)) {
        if (name in properties) continue;
        properties[name] = schema;
        queryKeys.push(name);
      }
      for (const name of parts.required) if (queryKeys.includes(name)) required.push(name);
    }
  }

  if (row.scoped) properties.projectId = PROJECT_ID_SCHEMA;

  let body: CatalogTool['body'] = 'none';
  const bodyKeys: string[] = [];
  const jsonInput = row.inputs.get('json');
  if (jsonInput) {
    const zod = resolve(jsonInput);
    const schema = jsonSchemaOf(zod, 'input');
    const parts = objectParts(schema);
    const collides = parts ? Object.keys(parts.properties).some((name) => name in properties) : true;
    if (parts && !collides && hoistDefs(root, schema)) {
      body = 'flat';
      for (const [name, prop] of Object.entries(parts.properties)) {
        properties[name] = prop;
        bodyKeys.push(name);
      }
      required.push(...parts.required);
    } else {
      body = 'nested';
      properties.body = schema;
      if (!zod.safeParse(undefined).success) required.push('body');
    }
  }
  if (required.length === 0) delete root.required;

  let outputSchema: JsonSchema | undefined;
  let outputWrapped = false;
  if (entry.response) {
    const schema = jsonSchemaOf(entry.response, 'output');
    // MCP wants an object at the root. A union of objects is one already, so it is said so
    // rather than wrapped; anything else (an array, a string) travels as `{ result }`.
    const union = (schema.anyOf ?? schema.oneOf) as JsonSchema[] | undefined;
    if (schema.type === 'object') {
      outputSchema = schema;
    } else if (Array.isArray(union) && union.length > 0 && union.every((member) => member.type === 'object')) {
      outputSchema = { type: 'object', ...schema };
    } else {
      outputWrapped = true;
      const defs = schema.$defs;
      delete schema.$defs;
      outputSchema = { type: 'object', properties: { result: schema }, required: ['result'], ...(defs ? { $defs: defs } : {}) };
    }
  }

  const readOnly = row.method === 'GET';
  const name = toolNameOf(row.method, row.path, entry, collections);
  const spelled = `${row.method} ${API}${row.scoped ? '/p/{projectId}' : ''}${row.path}`;
  return {
    name,
    description: `${entry.summary} (${spelled})`,
    method: row.method,
    path: row.path,
    scoped: row.scoped,
    set: setOf(row.path, entry),
    params: pathParams,
    query: queryKeys,
    body,
    bodyKeys,
    inputSchema: root,
    ...(outputSchema ? { outputSchema } : {}),
    outputWrapped,
    annotations: {
      title: entry.summary.replace(/\.$/, ''),
      readOnlyHint: readOnly,
      destructiveHint: destructiveHintOf(row.method, entry),
      idempotentHint: readOnly || row.method === 'PUT' || row.method === 'DELETE',
      openWorldHint: OPEN_WORLD.has(familyOf(row.path)),
    },
  };
}

/** A write is destructive unless its route-table entry says otherwise. */
export function destructiveHintOf(method: string, entry: RouteContract): boolean {
  return method !== 'GET' && entry.destructive !== false;
}

/**
 * The catalog for a built app's routes. Never throws for a missing entry — it reports it, and the
 * route is simply not a tool; `catalog.test.ts` makes that report a failure, which is the
 * build-time rule. A duplicate tool name does throw: two routes behind one name is a broken API.
 */
export function buildCatalog(routes: readonly RouteRow[]): { catalog: Catalog; problems: CatalogProblems } {
  const collected = collect(routes);
  const missing: string[] = [];
  const collections = new Set([...collected.values()].filter((row) => row.method === 'GET').map((row) => row.path));
  const tools: CatalogTool[] = [];
  for (const [key, row] of collected) {
    const entry = routeContractOf(row.method, row.path);
    if (!entry) {
      missing.push(key);
      continue;
    }
    if (entry.notTool) continue;
    tools.push(buildTool(row, entry, collections));
  }
  const stale = Object.keys(routeContracts).filter((key) => !collected.has(key));
  tools.sort((a, b) => a.name.localeCompare(b.name));
  const byName = new Map<string, CatalogTool>();
  for (const tool of tools) {
    const clash = byName.get(tool.name);
    if (clash) throw new Error(`MCP tool name ${tool.name} is both ${clash.method} ${clash.path} and ${tool.method} ${tool.path} — give one a \`tool\` name in packages/contract/src/routes.ts`);
    if (!/^[a-z0-9_]{1,64}$/.test(tool.name)) throw new Error(`MCP tool name ${tool.name} is not a valid tool name`);
    byName.set(tool.name, tool);
  }
  return { catalog: { tools, byName }, problems: { missing: missing.sort(), stale: stale.sort() } };
}

/** Every set the catalog has, for `?tools=` validation and help text. */
export function toolSetsOf(catalog: Catalog): string[] {
  return [...new Set(catalog.tools.map((tool) => tool.set))].sort();
}

/**
 * The sets a client asked for: `all`, a comma list, or nothing (the default sets). An unknown
 * name is an error the caller shows, never a silent empty list.
 */
export function selectTools(catalog: Catalog, request: string | undefined): { tools: CatalogTool[] } | { error: string } {
  const names = (request ?? '').split(',').map((name) => name.trim()).filter(Boolean);
  if (names.includes('all')) return { tools: catalog.tools };
  const wanted = names.length > 0 ? names : [...DEFAULT_TOOL_SETS];
  const known = toolSetsOf(catalog);
  const unknown = wanted.filter((name) => !known.includes(name));
  if (unknown.length > 0) return { error: `unknown tool set: ${unknown.join(', ')} (known: all, ${known.join(', ')})` };
  return { tools: catalog.tools.filter((tool) => wanted.includes(tool.set)) };
}
