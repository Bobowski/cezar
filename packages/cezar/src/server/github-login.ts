import { spawn, type ChildProcess } from 'node:child_process';
import type { GithubLoginState } from '@open-mercato/cezar-contract';
import { ghEnv } from '../core/gh-env.ts';

/**
 * `POST/GET/DELETE /api/v1/github/login` (spec 2026-10-26-first-run-onboarding, "Sign in does
 * the work"): the GitHub device flow driven by cezar instead of by a terminal the user has to
 * find. cezar spawns `gh auth login --web` with no terminal attached, reads the one-time code
 * `gh` prints, hands it to the cockpit (which shows it with a Copy button and opens GitHub), and
 * keeps the process alive while `gh` polls GitHub for the approval. When `gh` exits 0 the token
 * is wherever `gh` keeps it — the same place `publish-github` and the GitHub tab read from.
 *
 * One login at a time: a second start while one is pending answers the pending one, because two
 * codes on two screens would each invalidate the other.
 */

const GH_LOGIN_ARGS = ['auth', 'login', '--hostname', 'github.com', '--git-protocol', 'https', '--web', '--skip-ssh-key'];
const CODE_PATTERN = /one-time code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})/i;
const URL_PATTERN = /(https?:\/\/\S+\/login\/device\S*)/;
const DEFAULT_URL = 'https://github.com/login/device';
/** `gh` prints the code within a second or two; longer means it is stuck on something else. */
const CODE_TIMEOUT_MS = 20_000;
export const GH_LOGIN_MISSING = 'gh CLI not found — install it from https://cli.github.com';

export type GithubLoginSpawn = (args: string[]) => ChildProcess;

export interface GithubLogin {
  /** Starts a login, or answers the one already running. Resolves once the code is known (or the
   *  process failed before printing one). */
  start(): Promise<GithubLoginState>;
  read(): GithubLoginState;
  cancel(): void;
}

export function createGithubLogin(opts: { spawn?: GithubLoginSpawn; codeTimeoutMs?: number } = {}): GithubLogin {
  const spawnGh = opts.spawn ?? defaultSpawn;
  const codeTimeoutMs = opts.codeTimeoutMs ?? CODE_TIMEOUT_MS;
  let state: GithubLoginState = { status: 'idle' };
  let child: ChildProcess | null = null;
  let starting: Promise<GithubLoginState> | null = null;

  const settle = (next: GithubLoginState): void => {
    state = next;
    child = null;
  };

  const start = (): Promise<GithubLoginState> => {
    if (starting) return starting;
    if (state.status === 'pending') return Promise.resolve(state);
    state = { status: 'starting' };
    starting = new Promise<GithubLoginState>((resolveCode) => {
      let output = '';
      let codeSeen = false;
      let codeTimer: ReturnType<typeof setTimeout> | null = null;
      const resolveOnce = (value: GithubLoginState): void => {
        if (codeSeen) return;
        codeSeen = true;
        if (codeTimer) clearTimeout(codeTimer);
        starting = null;
        resolveCode(value);
      };
      let proc: ChildProcess;
      try {
        proc = spawnGh(GH_LOGIN_ARGS);
      } catch (err) {
        settle({ status: 'failed', error: errText(err), notFound: isNotFound(err) });
        resolveOnce(state);
        return;
      }
      child = proc;
      codeTimer = setTimeout(() => {
        proc.kill();
        settle({ status: 'failed', error: 'gh did not print a one-time code' });
        resolveOnce(state);
      }, codeTimeoutMs);
      const onData = (chunk: Buffer | string): void => {
        output += chunk.toString();
        if (output.length > 16_384) output = output.slice(-8_192);
        const code = CODE_PATTERN.exec(output)?.[1]?.toUpperCase();
        if (code && !codeSeen) {
          state = { status: 'pending', code, url: URL_PATTERN.exec(output)?.[1] ?? DEFAULT_URL };
          resolveOnce(state);
        }
      };
      proc.stdout?.on('data', onData);
      proc.stderr?.on('data', onData);
      proc.on('error', (err) => {
        if (child !== proc) return;
        settle({ status: 'failed', error: errText(err), notFound: isNotFound(err) });
        resolveOnce(state);
      });
      proc.on('exit', (code) => {
        if (child !== proc) return;
        if (codeTimer) clearTimeout(codeTimer);
        if (code === 0) settle({ status: 'done' });
        else settle({ status: 'failed', error: lastLine(output) || `gh exited with code ${code ?? 'null'}` });
        resolveOnce(state);
      });
    });
    return starting;
  };

  const cancel = (): void => {
    const proc = child;
    child = null;
    starting = null;
    proc?.kill();
    state = { status: 'idle' };
  };

  return { start, read: () => state, cancel };
}

/** `CEZ_DRY_RUN=1`: a fake code that approves itself after a few seconds, so the dialog can be
 *  walked without touching GitHub. */
export function createDryRunGithubLogin(approveAfterMs = 6_000): GithubLogin {
  let state: GithubLoginState = { status: 'idle' };
  let timer: ReturnType<typeof setTimeout> | null = null;
  return {
    start: () => {
      if (state.status !== 'pending') {
        state = { status: 'pending', code: 'DRY1-RUN2', url: DEFAULT_URL };
        timer = setTimeout(() => {
          state = { status: 'done' };
          timer = null;
        }, approveAfterMs);
      }
      return Promise.resolve(state);
    },
    read: () => state,
    cancel: () => {
      if (timer) clearTimeout(timer);
      timer = null;
      state = { status: 'idle' };
    },
  };
}

function defaultSpawn(args: string[]): ChildProcess {
  return spawn('gh', args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    // No terminal: `gh` then prints the code and the URL instead of waiting for Enter, and
    // never opens a browser of its own — the cockpit does that, on the machine the user is at.
    env: { ...ghEnv(), GH_PROMPT_DISABLED: '1', BROWSER: process.platform === 'win32' ? 'rem' : 'true' },
  });
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isNotFound(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { code?: unknown }).code === 'ENOENT';
}

function lastLine(text: string): string {
  const lines = text.split('\n').map((line) => line.trim()).filter((line) => line !== '' && !CODE_PATTERN.test(line) && !URL_PATTERN.test(line));
  return lines.at(-1) ?? '';
}
