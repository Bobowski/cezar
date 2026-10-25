import {
  maskMcpValue,
  mcpSecretNames,
  type McpScope,
  type McpServer,
  type McpServerDefinition,
  type McpServersList,
} from '@open-mercato/cezar-contract';
import { loadPrivateMcp, loadProjectMcp, mcpReachOf, PRIVATE_TRACKED_PROBLEM, privateMcpTrackedProblem, type PrivateMcpServer } from '../core/private-mcp.ts';
import { MCP_CATALOG } from '../mcp-catalog/catalog.ts';
import type { SecretStore } from '../workspace/secrets.ts';
import { privateOverrideHash, projectApprovalView, readPrivateOverrides } from './approval.ts';
import { redactMcpArgs, redactMcpUrl } from './redact.ts';
import { mcpStatusOf, readMcpStatus } from './status.ts';

/**
 * `GET /mcp-servers` (spec `2026-10-24-easy-mcp` §3–§4): both files, each server with what
 * Settings shows — transport, the agents it reaches, the secrets it references and which of them a
 * launch could not resolve, and the last launch's outcome. A literal env or header value is never
 * served (it may be a pasted token in the private file), nor the literal half of a value mixing text
 * with a reference; a `${{ secrets.X }}` reference is, since it names a secret and is not one.
 */

/** A launch-ready server back to the file's definition shape (what Test and the secret scan read). */
export function definitionOfServer(server: PrivateMcpServer): McpServerDefinition {
  if (server.transport === 'stdio') {
    return { command: server.command!, args: server.args, ...(Object.keys(server.env).length ? { env: server.env } : {}) };
  }
  return { type: server.transport, url: server.url!, ...(Object.keys(server.headers).length ? { headers: server.headers } : {}) };
}

const masked = (record: Record<string, string>) => Object.entries(record).map(([key, value]) => ({ key, value: maskMcpValue(value) }));

/** The secret names a `cezar` reader can resolve for this project: the project's and the workspace's. */
export async function cezarSecretNames(secrets: SecretStore, project: { projectId: string; root: string } | undefined): Promise<Set<string>> {
  const names = new Set<string>();
  const scopes = [{ kind: 'workspace' as const }, ...(project ? [{ kind: 'project' as const, ...project }] : [])];
  for (const scope of scopes) {
    const listed = await secrets.list(scope).catch(() => ({ secrets: [] }));
    for (const entry of listed.secrets) if (entry.audiences.includes('cezar')) names.add(entry.name);
  }
  return names;
}

export interface ListMcpServersDeps {
  secrets: SecretStore;
  /** Absent for an unregistered boot project: only workspace secrets resolve then. */
  project?: { projectId: string; root: string };
  editable: boolean;
  /** Args and url as written: only for an `admin` caller on a trusted cockpit. Default: redacted. */
  raw?: boolean;
}

export async function listMcpServers(repoRoot: string, deps: ListMcpServersDeps): Promise<McpServersList> {
  const [project, priv, statuses, available, approval, overrides, trackCheck] = await Promise.all([
    loadProjectMcp(repoRoot),
    loadPrivateMcp(repoRoot),
    readMcpStatus(repoRoot),
    cezarSecretNames(deps.secrets, deps.project),
    projectApprovalView(repoRoot, { raw: deps.raw === true }),
    readPrivateOverrides(repoRoot),
    privateMcpTrackedProblem(repoRoot),
  ]);
  // A check that failed refuses the file, but only a file with servers has anything to refuse.
  const trackedProblem = trackCheck === PRIVATE_TRACKED_PROBLEM || priv.servers.length > 0 ? trackCheck : null;
  const tracked = trackedProblem !== null;
  // Only an approval of the current content binds anything (spec 2026-10-24-easy-mcp §5).
  const boundOf = (name: string) => (approval.state === 'approved' ? (approval.bindings[name] ?? []) : []);
  // A tracked private file is refused at launch, so it replaces nothing.
  const privateServers = new Map(tracked ? [] : priv.servers.map((server) => [server.name, server] as const));
  const projectNames = new Set(project.servers.map((server) => server.name));
  const confirmed = (server: PrivateMcpServer) => overrides[server.name] === privateOverrideHash(server);
  // As at launch: a project server that would go is replaced only by a confirmed private entry.
  const replaced = (name: string, referenced: string[]) => {
    const mine = privateServers.get(name);
    const goes = approval.state === 'approved' && referenced.every((secret) => boundOf(name).includes(secret));
    return mine !== undefined && (!goes || confirmed(mine));
  };
  const row = (server: PrivateMcpServer, scope: McpScope): McpServer => {
    const referenced = mcpSecretNames(definitionOfServer(server));
    const status = mcpStatusOf(statuses, scope, server.name);
    return {
      name: server.name,
      scope,
      transport: server.transport,
      ...(server.command ? { command: deps.raw ? server.command : redactMcpUrl(server.command) } : {}),
      args: deps.raw ? server.args : redactMcpArgs(server.args),
      ...(server.url ? { url: deps.raw ? server.url : redactMcpUrl(server.url) } : {}),
      env: masked(server.env),
      headers: masked(server.headers),
      secrets: referenced,
      missingSecrets: referenced.filter((name) => !available.has(name)),
      shadowed: scope === 'project' && replaced(server.name, referenced),
      // A tracked file replaces nothing, so there is no replacement to confirm.
      ...(scope === 'private' && !tracked && projectNames.has(server.name) ? { override: { hash: privateOverrideHash(server), confirmed: confirmed(server) } } : {}),
      reach: mcpReachOf(server.transport, { secretBearing: referenced.length > 0 }),
      ...(status ? { status } : {}),
      ...(scope === 'project' ? { boundSecrets: boundOf(server.name).filter((name) => referenced.includes(name)) } : {}),
    };
  };
  return {
    project: project.servers.map((server) => row(server, 'project')),
    private: priv.servers.map((server) => row(server, 'private')),
    problems: { project: project.problems, private: trackedProblem ? [...priv.problems, trackedProblem] : priv.problems },
    catalog: [...MCP_CATALOG],
    editable: deps.editable,
    approval,
  };
}
