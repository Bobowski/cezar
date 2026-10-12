import type { PtyBinding, PtyProcess, PtySpawnOptions } from '../server/terminal/pty-module.ts';

/** A PTY that records what it was told, so no test forks a real process. */
export class FakeServicePty implements PtyProcess {
  readonly pid = 4242;
  written: string[] = [];
  killed = 0;
  private data?: (chunk: string) => void;
  private exit?: (event: { exitCode: number; signal?: number }) => void;
  constructor(readonly file: string, readonly args: string[], readonly options: PtySpawnOptions) {}
  onData(listener: (chunk: string) => void) { this.data = listener; return { dispose: () => {} }; }
  onExit(listener: (event: { exitCode: number; signal?: number }) => void) { this.exit = listener; return { dispose: () => {} }; }
  write(data: string) { this.written.push(data); }
  resize() {}
  kill() { this.killed += 1; }
  emit(chunk: string) { this.data?.(chunk); }
  finish(exitCode: number) { this.exit?.({ exitCode }); }
}

export function fakeServiceBinding(options: { fail?: () => string | null } = {}) {
  const spawned: FakeServicePty[] = [];
  const binding = async (): Promise<PtyBinding> => ({
    available: true,
    module: {
      spawn: (file: string, args: string[], spawnOptions: PtySpawnOptions): PtyProcess => {
        const failure = options.fail?.();
        if (failure) throw new Error(failure);
        const pty = new FakeServicePty(file, args, spawnOptions);
        spawned.push(pty);
        return pty;
      },
    },
  });
  return { binding, spawned };
}
