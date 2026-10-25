import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { mcpServerStatusSchema, type McpScope, type McpServerStatus } from '@open-mercato/cezar-contract';
import { renameWithRetry } from '../fs-rename.ts';

/**
 * The last launch each MCP server reached (spec `2026-10-24-easy-mcp` §3: "status — last launch
 * injected / failed with reason, from the run notes"). The run notes stay the record; this file
 * is their index, so Settings need not read every run's event log. Written best-effort at launch,
 * git-ignored, and safe to delete: an absent file is "never launched".
 */

export const MCP_STATUS_FILE = 'mcp-status.json';

export function mcpStatusPath(repoRoot: string): string {
  return join(repoRoot, '.ai', 'cezar', MCP_STATUS_FILE);
}

const fileSchema = z.object({ servers: z.record(z.string(), mcpServerStatusSchema.catch(undefined as never)) }).catch({ servers: {} });

const keyOf = (scope: McpScope, name: string) => `${scope}:${name}`;

/** Every recorded status, keyed `<scope>:<name>`. Never throws. */
export async function readMcpStatus(repoRoot: string): Promise<Map<string, McpServerStatus>> {
  try {
    const parsed = fileSchema.parse(JSON.parse(await readFile(mcpStatusPath(repoRoot), 'utf8')));
    return new Map(Object.entries(parsed.servers).filter((entry): entry is [string, McpServerStatus] => Boolean(entry[1])));
  } catch {
    return new Map();
  }
}

export function mcpStatusOf(statuses: Map<string, McpServerStatus>, scope: McpScope, name: string): McpServerStatus | undefined {
  return statuses.get(keyOf(scope, name));
}

export interface McpLaunchOutcome {
  scope: McpScope;
  name: string;
  state: McpServerStatus['state'];
  reason?: string;
}

let queue: Promise<void> = Promise.resolve();

/** Record one launch's outcomes. Serialized per process; a failure to write is silent (informational state). */
export function recordMcpLaunch(repoRoot: string, launch: { runId: string; runner: string }, outcomes: readonly McpLaunchOutcome[]): Promise<void> {
  if (outcomes.length === 0) return queue;
  queue = queue.then(async () => {
    try {
      const current = await readMcpStatus(repoRoot);
      const at = new Date().toISOString();
      for (const outcome of outcomes) {
        current.set(keyOf(outcome.scope, outcome.name), {
          state: outcome.state,
          at,
          runId: launch.runId,
          runner: launch.runner,
          ...(outcome.reason ? { reason: outcome.reason } : {}),
        });
      }
      const path = mcpStatusPath(repoRoot);
      await mkdir(join(repoRoot, '.ai', 'cezar'), { recursive: true });
      const tmp = `${path}.${process.pid}.tmp`;
      await writeFile(tmp, `${JSON.stringify({ servers: Object.fromEntries(current) }, null, 2)}\n`, 'utf8');
      await renameWithRetry(tmp, path);
    } catch {
      // informational: a read-only checkout loses the status line, never a run
    }
  });
  return queue;
}
