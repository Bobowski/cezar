import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { mcpProjectLiteralIssue, type McpScope, type McpServerDefinition } from '@open-mercato/cezar-contract';
import { privateMcpPath, projectMcpPath } from '../core/private-mcp.ts';
import { ensureDataGitignore } from '../data-gitignore.ts';
import { renameWithRetry } from '../fs-rename.ts';

/**
 * Writes behind Settings → MCP servers (spec `2026-10-24-easy-mcp` §4): one entry of
 * `.ai/cezar/mcp.json` (committed) or `.ai/cezar/mcp.local.json` (private, `0600`). Every other
 * key of the file — the user's own, another server — is kept. A file that is not JSON is refused,
 * never overwritten: it is fixed by hand in Agent config. The git-ignore allowlist is in place
 * before the bytes land, so the private file and every temp name are ignored from their first write.
 */

export type McpFileWrite = { ok: true } | { ok: false; status: 400 | 404 | 409; error: string };

export function mcpFilePath(repoRoot: string, scope: McpScope): string {
  return scope === 'project' ? projectMcpPath(repoRoot) : privateMcpPath(repoRoot);
}

const locks = new Map<string, Promise<unknown>>();

/** One read-modify-write per file at a time in this process. */
function locked<T>(path: string, work: () => Promise<T>): Promise<T> {
  const previous = locks.get(path) ?? Promise.resolve();
  const next = previous.then(work, work);
  locks.set(path, next.catch(() => {}));
  return next;
}

async function readObject(path: string): Promise<{ data: Record<string, unknown> } | { error: string }> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { data: {} };
    return { error: `the file could not be read: ${(error as Error).message}` };
  }
  if (text.trim() === '') return { data: {} };
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return { data: parsed as Record<string, unknown> };
  } catch {
    // reported below
  }
  return { error: 'the file is not a JSON object — fix it in Settings → Agent config before adding servers here' };
}

async function update(
  repoRoot: string,
  scope: McpScope,
  mutate: (servers: Record<string, unknown>) => boolean,
): Promise<McpFileWrite> {
  const path = mcpFilePath(repoRoot, scope);
  return locked(path, async () => {
    const read = await readObject(path);
    if ('error' in read) return { ok: false, status: 409, error: read.error };
    const current = read.data.mcpServers;
    const servers: Record<string, unknown> = current && typeof current === 'object' && !Array.isArray(current) ? { ...(current as Record<string, unknown>) } : {};
    if (!mutate(servers)) return { ok: false, status: 404, error: 'no MCP server with that name' };
    try {
      await mkdir(dirname(path), { recursive: true });
      ensureDataGitignore(repoRoot);
      const tmp = `${path}.cez-tmp-${process.pid}-${randomUUID()}`;
      const content = `${JSON.stringify({ ...read.data, mcpServers: servers }, null, 2)}\n`;
      await writeFile(tmp, content, scope === 'private' ? { encoding: 'utf8', mode: 0o600 } : 'utf8');
      await renameWithRetry(tmp, path);
    } catch (error) {
      return { ok: false, status: 409, error: `could not write ${scope === 'project' ? 'mcp.json' : 'mcp.local.json'}: ${(error as Error).message}` };
    }
    return { ok: true };
  });
}

/** Store `definition` under `name`, replacing one of that name. */
export function putMcpServer(repoRoot: string, scope: McpScope, name: string, definition: McpServerDefinition): Promise<McpFileWrite> {
  // The committed file holds references only (spec 2026-10-24-easy-mcp §5).
  const literal = scope === 'project' ? mcpProjectLiteralIssue(definition) : null;
  if (literal) return Promise.resolve({ ok: false, status: 400, error: literal });
  return update(repoRoot, scope, (servers) => {
    servers[name] = definition;
    return true;
  });
}

/** Remove `name`; 404 when the file has no such server. */
export function deleteMcpServer(repoRoot: string, scope: McpScope, name: string): Promise<McpFileWrite> {
  return update(repoRoot, scope, (servers) => {
    if (!Object.hasOwn(servers, name)) return false;
    delete servers[name];
    return true;
  });
}
