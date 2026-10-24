/**
 * What the cockpit-facing CLIs (`cez task`, `cez automation`, `cez runs`) answer when they have no
 * cockpit address (#1080).
 *
 * `CEZ_API_URL` is deliberately never defaulted: for an agent, the variable being absent IS the
 * signal that the cockpit withheld dispatch or automations (`builtin-skill.ts`, `run.ts`
 * `dispatchReachable`), and a loopback fallback would turn that into writes against whichever
 * cockpit happens to own the port. So the fix is the message, not the resolution.
 *
 * Two callers read it. Inside a cezar task (`CEZ_TASK_ID`, which the engine sets for every agent)
 * the text is the agent instruction each CLI already had: stop and report, never improvise.
 * Everyone else is a person at a shell, and for them "only works inside a task" was false — the
 * CLIs work from any shell given the address, so that is what they are told.
 */
import { readHostKey } from './auth/host-key.ts';
import { isLoopbackHost } from './server/capabilities.ts';

/**
 * The credential a cockpit-facing CLI presents: a token it was given, else — for a person at a
 * shell, never a task, and only toward THIS machine — the host key. The host key is a local
 * secret: `--server https://elsewhere` must never carry it off the box.
 */
export function cockpitCredential(env: { CEZ_API_TOKEN?: string; CEZ_TASK_ID?: string; CEZ_API_URL?: string }): string | undefined {
  if (env.CEZ_API_TOKEN) return env.CEZ_API_TOKEN;
  if (env.CEZ_TASK_ID) return undefined;
  let hostname: string | undefined;
  try {
    hostname = env.CEZ_API_URL ? new URL(env.CEZ_API_URL).hostname : undefined;
  } catch {
    return undefined;
  }
  return hostname === undefined || isLoopbackHost(hostname) ? readHostKey() : undefined;
}

/**
 * `cez --server <url> --token <token> <command>` (spec 2026-10-24-cezar-mcp-server §4): the flags,
 * anywhere on the line, become `CEZ_API_URL` / `CEZ_API_TOKEN` for the cockpit-facing commands;
 * without them `CEZ_SERVER` / `CEZ_TOKEN` fill in what is unset — from a shell only: inside a task
 * the cockpit set the address and credential, and a user's exported VPS token is not the task's.
 * Answers the arguments with the two flags taken out.
 */
export function takeServerFlags(args: readonly string[], env: NodeJS.ProcessEnv): string[] {
  const rest: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    const match = /^--(server|token)(?:=(.*))?$/.exec(arg);
    if (!match) {
      rest.push(arg);
      continue;
    }
    const value = match[2] ?? args[++index];
    if (value === undefined || value === '') throw new Error(`--${match[1]} needs a value`);
    if (match[1] === 'server') env.CEZ_API_URL = value;
    else env.CEZ_API_TOKEN = value;
  }
  if (env.CEZ_TASK_ID) return rest;
  if (!env.CEZ_API_URL && env.CEZ_SERVER) env.CEZ_API_URL = env.CEZ_SERVER;
  if (!env.CEZ_API_TOKEN && env.CEZ_TOKEN) env.CEZ_API_TOKEN = env.CEZ_TOKEN;
  return rest;
}

/**
 * The warning a shell hears when `--server` / `CEZ_SERVER` names another machine over plain
 * `http://`: its token (and every prompt) would cross the network in clear. Null otherwise, and
 * always null inside a task, whose address is the cockpit's choice.
 */
export function plainHttpWarning(env: { CEZ_API_URL?: string; CEZ_TASK_ID?: string }): string | null {
  if (env.CEZ_TASK_ID || !env.CEZ_API_URL) return null;
  let url: URL;
  try {
    url = new URL(env.CEZ_API_URL);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' || isLoopbackHost(url.hostname)) return null;
  return `cezar: warning — ${url.origin} is plain http, so the API token and everything sent travel unencrypted; use its https:// address.`;
}

export const DEFAULT_COCKPIT_URL = 'http://127.0.0.1:4321';

export interface MissingCockpitMessage {
  /** The command as typed, e.g. `cez automation`. */
  command: string;
  /** A read-only invocation to show a person, e.g. `cez automation list`. */
  example: string;
  /** Said to an agent inside a task, after "CEZ_API_URL is not set — ". */
  insideTask: string;
}

export function missingCockpitMessage(message: MissingCockpitMessage, env: { CEZ_TASK_ID?: string }): string {
  if (env.CEZ_TASK_ID) return `${message.command}: CEZ_API_URL is not set — ${message.insideTask}`;
  return [
    `${message.command}: CEZ_API_URL is not set, so there is no cockpit to talk to.`,
    `Point it at a running cockpit — the address it printed after "cockpit →" when it started (${DEFAULT_COCKPIT_URL} by default):`,
    `  CEZ_API_URL=${DEFAULT_COCKPIT_URL} ${message.example}`,
    'On a cockpit serving several projects, add CEZ_PROJECT_ID=<id> (`cezar projects` lists them); without it the command addresses the project the cockpit was started in.',
    'Inside a cezar task the cockpit sets this variable itself — if it is missing there, the feature is off: do not set it by hand.',
  ].join('\n');
}

/**
 * `io` with the cockpit credential attached to every request (spec
 * 2026-10-12-cockpit-authentication §7): a task's own `CEZ_API_TOKEN`, or — for a person at a
 * shell, never for a task — this host's key file. With neither, `io` is returned untouched, so a
 * cockpit without auth sees exactly the requests it always did.
 */
export function withCockpitAuth<T extends { fetch: typeof fetch }>(
  io: T,
  env: { CEZ_API_TOKEN?: string; CEZ_TASK_ID?: string; CEZ_API_URL?: string },
): T {
  const token = cockpitCredential(env);
  if (!token) return io;
  return {
    ...io,
    fetch: (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set('authorization', `Bearer ${token}`);
      return io.fetch(input, { ...init, headers });
    },
  };
}
