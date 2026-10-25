import { parseArgs } from 'node:util';
import { cockpitCredential, DEFAULT_COCKPIT_URL, missingCockpitMessage } from '../cockpit-address.ts';
import { runMcpBridge, type BridgeIo, type BridgeTarget } from './stdio.ts';

/**
 * `cezar mcp [--tools <sets>]` — add cezar to Claude Code, Codex or any MCP client that launches
 * a command (spec 2026-10-24-cezar-mcp-server §3). On a local cockpit it needs nothing: the
 * address defaults to the local port and the host key authenticates it, like every other
 * shell-side CLI. `CEZ_TOKEN=<token> cez --server <url> mcp` points it at a hosted one.
 */

const USAGE = `cezar mcp — serve this cockpit's API to an MCP client over stdio

  cezar mcp [--tools <sets>]       --tools: a comma list of tool sets, or all
                                   (default: tasks,workflows,skills,projects)
  cezar mcp --as-run               the cockpit chat's own connection: the task's address and
                                   run token, never the host key (cezar starts it, not you)
  CEZ_TOKEN=<ceztok_…> cez --server https://<host> mcp    a hosted cockpit (or CEZ_SERVER; --token works,
                                   but shows in the process list)

  Claude Code:  claude mcp add cezar -- cezar mcp
  Over HTTP:    claude mcp add --transport http cezar https://<host>/api/v1/mcp --header "Authorization: Bearer <token>"

Tokens: Settings → Security → API tokens. A local cockpit needs none. Always https:// for another
machine: over plain http the token travels in clear (cez warns).`;

export interface McpCliEnv {
  CEZ_API_URL?: string;
  CEZ_API_TOKEN?: string;
  CEZ_TASK_ID?: string;
}

/**
 * Where the bridge connects and as whom. One function, so the run-scoped variant the cockpit
 * chat needs (`--as-run`: the task's own address and token, never the host key — spec
 * 2026-10-24-cockpit-chat) is a branch here, not a second entry point.
 */
export function bridgeTarget(env: McpCliEnv, tools: string | undefined, asRun = false): BridgeTarget | { error: string } {
  if (asRun && (!env.CEZ_TASK_ID || !env.CEZ_API_URL || !env.CEZ_API_TOKEN)) {
    return { error: 'cezar mcp --as-run: only a cockpit chat launches this (CEZ_TASK_ID, CEZ_API_URL and its CEZ_API_TOKEN are missing) — stop and report it.' };
  }
  const base = (env.CEZ_API_URL || DEFAULT_COCKPIT_URL).replace(/\/+$/, '');
  const endpoint = new URL(`${base}/api/v1/mcp`);
  if (tools) endpoint.searchParams.set('tools', tools);
  // The run's own token and nothing else: a chat never falls back to the host key.
  const credential = asRun ? env.CEZ_API_TOKEN : cockpitCredential({ ...env, CEZ_API_URL: base });
  return { endpoint: endpoint.toString(), ...(credential ? { credential } : {}) };
}

export async function runMcpCommand(
  args: string[],
  env: McpCliEnv = process.env,
  io: BridgeIo = { stdin: process.stdin, stdout: process.stdout, fetch, error: (line) => process.stderr.write(`${line}\n`) },
): Promise<number> {
  let values: { tools?: string; help?: boolean; 'as-run'?: boolean };
  try {
    ({ values } = parseArgs({
      args,
      options: { tools: { type: 'string' }, 'as-run': { type: 'boolean' }, help: { type: 'boolean', short: 'h' } },
      allowPositionals: false,
    }));
  } catch (error) {
    io.error(`cezar mcp: ${(error as Error).message}\n\n${USAGE}`);
    return 2;
  }
  if (values.help) {
    io.error(USAGE);
    return 0;
  }
  // Inside a task the address is never guessed (`cockpit-address.ts`): its absence is the cockpit's answer.
  if (env.CEZ_TASK_ID && !env.CEZ_API_URL) {
    io.error(missingCockpitMessage({ command: 'cezar mcp', example: 'cezar mcp', insideTask: 'this cockpit gave the task no address. Do not point it at one yourself: stop and report it.' }, env));
    return 2;
  }
  const target = bridgeTarget(env, values.tools, values['as-run'] === true);
  if ('error' in target) {
    io.error(target.error);
    return 2;
  }
  await runMcpBridge(target, io);
  return 0;
}
