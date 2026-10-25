import {
  hasMcpSecretReference,
  mcpSecretNames,
  type McpScope,
  type McpServer,
  type McpServerDefinition,
  type McpServersList,
} from '@open-mercato/cezar-contract';
import { loadPrivateMcp, loadProjectMcp, mcpReachOf, type PrivateMcpServer } from '../core/private-mcp.ts';
import { MCP_CATALOG } from '../mcp-catalog/catalog.ts';
import type { SecretStore } from '../workspace/secrets.ts';
import { mcpStatusOf, readMcpStatus } from './status.ts';

/**
 * `GET /mcp-servers` (spec `2026-10-24-easy-mcp` §3–§4): both files, each server with what
 * Settings shows — transport, the agents it reaches, the secrets it references and which of them a
 * launch could not resolve, and the last launch's outcome. A literal env or header value is never
 * served (it may be a pasted token in the private file); a value holding a `${{ secrets.X }}`
 * reference is, since the reference names a secret and is not one.
 */

/** A launch-ready server back to the file's definition shape (what Test and the secret scan read). */
export function definitionOfServer(server: PrivateMcpServer): McpServerDefinition {
  if (server.transport === 'stdio') {
    return { command: server.command!, args: server.args, ...(Object.keys(server.env).length ? { env: server.env } : {}) };
  }
  return { type: server.transport, url: server.url!, ...(Object.keys(server.headers).length ? { headers: server.headers } : {}) };
}

const masked = (record: Record<string, string>) =>
  Object.entries(record).map(([key, value]) => ({ key, value: hasMcpSecretReference(value) ? value : null }));

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
}

export async function listMcpServers(repoRoot: string, deps: ListMcpServersDeps): Promise<McpServersList> {
  const [project, priv, statuses, available] = await Promise.all([
    loadProjectMcp(repoRoot),
    loadPrivateMcp(repoRoot),
    readMcpStatus(repoRoot),
    cezarSecretNames(deps.secrets, deps.project),
  ]);
  const privateNames = new Set(priv.servers.map((server) => server.name));
  const row = (server: PrivateMcpServer, scope: McpScope): McpServer => {
    const referenced = mcpSecretNames(definitionOfServer(server));
    const status = mcpStatusOf(statuses, scope, server.name);
    return {
      name: server.name,
      scope,
      transport: server.transport,
      ...(server.command ? { command: server.command } : {}),
      args: server.args,
      ...(server.url ? { url: server.url } : {}),
      env: masked(server.env),
      headers: masked(server.headers),
      secrets: referenced,
      missingSecrets: referenced.filter((name) => !available.has(name)),
      shadowed: scope === 'project' && privateNames.has(server.name),
      reach: mcpReachOf(server.transport),
      ...(status ? { status } : {}),
    };
  };
  return {
    project: project.servers.map((server) => row(server, 'project')),
    private: priv.servers.map((server) => row(server, 'private')),
    problems: { project: project.problems, private: priv.problems },
    catalog: [...MCP_CATALOG],
    editable: deps.editable,
  };
}
