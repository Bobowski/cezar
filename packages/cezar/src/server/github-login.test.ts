import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { createDryRunGithubLogin, createGithubLogin } from './github-login.ts';

/** The GitHub device flow run by cezar (spec 2026-10-26-first-run-onboarding, "Sign in does the
 *  work"). `gh` is faked as a child process whose stderr the test writes, which is exactly the
 *  surface the real one uses: the code and the URL arrive on stderr, the exit code says whether
 *  GitHub approved. */
class FakeGh extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killed = false;
  kill(): boolean {
    this.killed = true;
    return true;
  }
  say(text: string): void {
    this.stderr.emit('data', Buffer.from(text));
  }
  exit(code: number): void {
    this.emit('exit', code, null);
  }
}

const asChild = (fake: FakeGh): ChildProcess => fake as unknown as ChildProcess;

describe('createGithubLogin', () => {
  it('resolves start() with the one-time code gh printed, then reports done on exit 0', async () => {
    const gh = new FakeGh();
    const login = createGithubLogin({ spawn: () => asChild(gh) });

    const started = login.start();
    expect(login.read()).toEqual({ status: 'starting' });
    gh.say('\n');
    gh.say('! First copy your one-time code: C4AD-605F\nOpen this URL to continue in your web browser: https://github.com/login/device\n');

    expect(await started).toEqual({ status: 'pending', code: 'C4AD-605F', url: 'https://github.com/login/device' });
    gh.exit(0);
    expect(login.read()).toEqual({ status: 'done' });
  });

  it('answers the pending login instead of starting a second one', async () => {
    const spawn = vi.fn(() => {
      const gh = new FakeGh();
      setTimeout(() => gh.say('! First copy your one-time code: AAAA-1111\n'), 0);
      return asChild(gh);
    });
    const login = createGithubLogin({ spawn });

    const [first, second] = await Promise.all([login.start(), login.start()]);
    expect(await login.start()).toEqual(first);
    expect(second).toEqual(first);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("reports gh's last line when GitHub denies or the code expires", async () => {
    const gh = new FakeGh();
    const login = createGithubLogin({ spawn: () => asChild(gh) });
    const started = login.start();
    gh.say('! First copy your one-time code: BBBB-2222\n');
    await started;

    gh.say('error: The device code has expired\n');
    gh.exit(1);
    expect(login.read()).toEqual({ status: 'failed', error: 'error: The device code has expired' });
  });

  it('flags a missing gh so the route can answer 503 with the install hint', async () => {
    const login = createGithubLogin({
      spawn: () => {
        throw Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' });
      },
    });
    expect(await login.start()).toEqual({ status: 'failed', error: 'spawn gh ENOENT', notFound: true });
  });

  it('gives up when gh never prints a code', async () => {
    const gh = new FakeGh();
    const login = createGithubLogin({ spawn: () => asChild(gh), codeTimeoutMs: 20 });
    expect(await login.start()).toEqual({ status: 'failed', error: 'gh did not print a one-time code' });
    expect(gh.killed).toBe(true);
  });

  it('cancel kills the process and a later exit does not resurrect the state', async () => {
    const gh = new FakeGh();
    const login = createGithubLogin({ spawn: () => asChild(gh) });
    const started = login.start();
    gh.say('! First copy your one-time code: CCCC-3333\n');
    await started;

    login.cancel();
    expect(gh.killed).toBe(true);
    gh.exit(1);
    expect(login.read()).toEqual({ status: 'idle' });
  });
});

describe('createDryRunGithubLogin', () => {
  it('hands out a fake code and approves itself', async () => {
    vi.useFakeTimers();
    try {
      const login = createDryRunGithubLogin(50);
      expect(await login.start()).toEqual({ status: 'pending', code: 'DRY1-RUN2', url: 'https://github.com/login/device' });
      vi.advanceTimersByTime(60);
      expect(login.read()).toEqual({ status: 'done' });
    } finally {
      vi.useRealTimers();
    }
  });
});
