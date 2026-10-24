import { spawn } from 'node:child_process';
import { collectSecretValues, redactSecrets } from '../core/secret-redaction.ts';

/**
 * `docker logs --tail 500 --follow <id>`, one process per container while someone looks (spec
 * `2026-10-23-docker-management` §3.4). Demand-driven twice over: a topic subscriber holds the
 * follower (the last release kills it), and a read keeps it alive for `idleMs` — the hosted
 * cockpit, which opens no socket, polls. Output is redacted line by line before it is kept.
 */

export interface FollowedProcess {
  kill(): void;
}
export type DockerSpawn = (
  args: string[],
  on: { data: (stream: 'out' | 'err', chunk: string) => void; exit: (reason: string | null) => void },
) => FollowedProcess;

export const dockerSpawn: DockerSpawn = (args, on) => {
  // Dry run stays off the host's tools, like `dockerExec`.
  if (process.env.CEZ_DRY_RUN === '1') {
    queueMicrotask(() => on.exit('Docker is not read in a dry run'));
    return { kill: () => undefined };
  }
  let done = false;
  const exit = (reason: string | null) => {
    if (done) return;
    done = true;
    on.exit(reason);
  };
  const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => on.data('out', chunk));
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => on.data('err', chunk));
  child.on('error', (err: NodeJS.ErrnoException) => exit(err.code === 'ENOENT' ? 'docker is not on PATH' : err.message));
  child.on('close', () => exit(null));
  return { kill: () => { if (!done) child.kill(); } };
};

export const TAIL_LINES = 500;
/** Kept per container; older output is dropped and a reader behind it is told so. */
const MAX_CHARS = 512 * 1024;
/** A line longer than this is redacted and kept without waiting for its newline. */
const MAX_PENDING = 8 * 1024;
const BELL_MS = 200;

interface Entry {
  proc: FollowedProcess | null;
  following: boolean;
  text: string;
  /** Cursor of `text[0]`. */
  start: number;
  pending: { out: string; err: string };
  holders: number;
  lastRead: number;
  bell: ReturnType<typeof setTimeout> | null;
  /** When we killed the follower (ms), so the next one picks up `--since` then; `null` once Docker ended it. */
  resumeFrom: number | null;
}

export interface DockerLogsRead { data: string; cursor: number; truncated: boolean; following: boolean }

export class DockerLogFollowers {
  private readonly entries = new Map<string, Entry>();
  private sweep: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly spawnDocker: DockerSpawn,
    /** "There is more" — called with the new cursor, coalesced. */
    private readonly onCursor: (id: string, cursor: number) => void,
    /** The follower is gone for good (idle): its topic can be dropped. */
    private readonly onForget: (id: string) => void,
    private readonly options: { idleMs?: number; now?: () => number; secrets?: () => readonly string[] } = {},
  ) {}

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private redact(text: string): string {
    if (process.env.CEZ_REDACT_SECRETS === '0') return text;
    return redactSecrets(text, this.options.secrets?.() ?? collectSecretValues());
  }

  private entry(id: string): Entry {
    let entry = this.entries.get(id);
    if (!entry) {
      entry = { proc: null, following: false, text: '', start: 0, pending: { out: '', err: '' }, holders: 0, lastRead: this.now(), bell: null, resumeFrom: null };
      this.entries.set(id, entry);
      this.armSweep();
    }
    return entry;
  }

  private append(id: string, entry: Entry, text: string): void {
    if (text === '') return;
    entry.text += text;
    if (entry.text.length > MAX_CHARS) {
      const drop = entry.text.length - MAX_CHARS;
      entry.text = entry.text.slice(drop);
      entry.start += drop;
    }
    if (entry.bell) return;
    entry.bell = setTimeout(() => {
      entry.bell = null;
      this.onCursor(id, entry.start + entry.text.length);
    }, BELL_MS);
    entry.bell.unref?.();
  }

  /** Attach `docker logs`: the last `TAIL_LINES` for a fresh pane, or from where a release cut it off. */
  private start(id: string, entry: Entry, fresh: boolean): void {
    const since = entry.resumeFrom;
    if (fresh || since === null) {
      entry.text = '';
      entry.start = 0;
    }
    entry.resumeFrom = null;
    entry.following = true;
    const from = !fresh && since !== null ? ['--since', new Date(since).toISOString()] : ['--tail', String(TAIL_LINES)];
    const proc = this.spawnDocker(['logs', ...from, '--follow', id], {
      data: (stream, chunk) => {
        if (entry.proc !== proc) return;
        // Whole lines only, so a secret split across two chunks is still one string when redacted.
        const pending = entry.pending[stream] + chunk;
        const cut = pending.length > MAX_PENDING ? pending.length : pending.lastIndexOf('\n') + 1;
        entry.pending[stream] = pending.slice(cut);
        this.append(id, entry, this.redact(pending.slice(0, cut)));
      },
      exit: (reason) => {
        if (entry.proc !== proc) return;
        const rest = entry.pending.out + entry.pending.err;
        entry.pending = { out: '', err: '' };
        this.append(id, entry, this.redact(rest) + (reason ? `\n[${reason}]\n` : ''));
        entry.proc = null;
        entry.following = false;
        this.onCursor(id, entry.start + entry.text.length);
      },
    });
    entry.proc = proc;
  }

  private stop(entry: Entry): void {
    const proc = entry.proc;
    if (!proc) return;
    entry.proc = null;
    entry.following = false;
    // Cut off by us, not ended by Docker: a returning reader resumes from here.
    entry.resumeFrom = this.now();
    proc.kill();
  }

  /** Re-attach what a release cut off, or start a fresh one; a follower Docker ended stays ended. */
  private ensure(id: string, entry: Entry, fresh: boolean): void {
    if (entry.proc) return;
    if (fresh || entry.text === '' || entry.resumeFrom !== null) this.start(id, entry, fresh || entry.text === '');
  }

  /**
   * Output since `cursor`. A first read (cursor 0) starts afresh — that is a pane opened again —
   * while a reader with a cursor keeps what it was shown.
   */
  read(id: string, cursor: number): DockerLogsRead {
    const entry = this.entry(id);
    entry.lastRead = this.now();
    this.ensure(id, entry, cursor === 0 && !entry.following);
    const end = entry.start + entry.text.length;
    const from = cursor > end ? 0 : cursor;
    const truncated = from > 0 && from < entry.start;
    return {
      data: entry.text.slice(Math.max(0, from - entry.start)),
      cursor: end,
      truncated: truncated || cursor > end,
      following: entry.following,
    };
  }

  cursorOf(id: string): number {
    const entry = this.entries.get(id);
    return entry ? entry.start + entry.text.length : 0;
  }

  /** A topic subscriber arrived. */
  hold(id: string): void {
    const entry = this.entry(id);
    entry.holders += 1;
    entry.lastRead = this.now();
    this.ensure(id, entry, false);
  }

  /** The last subscriber leaving kills the process; the kept output ages out with the entry. */
  release(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.holders = Math.max(0, entry.holders - 1);
    if (entry.holders === 0) this.stop(entry);
  }

  /** Followers currently attached — what tests and the idle sweep look at. */
  running(): string[] {
    return [...this.entries].filter(([, entry]) => entry.proc !== null).map(([id]) => id);
  }

  /** Drop every entry nobody holds and nobody read for `idleMs`. */
  sweepIdle(): void {
    const idle = this.options.idleMs ?? 15_000;
    for (const [id, entry] of this.entries) {
      if (entry.holders > 0 || this.now() - entry.lastRead < idle) continue;
      this.stop(entry);
      if (entry.bell) clearTimeout(entry.bell);
      this.entries.delete(id);
      this.onForget(id);
    }
    if (this.entries.size === 0 && this.sweep) {
      clearInterval(this.sweep);
      this.sweep = null;
    }
  }

  private armSweep(): void {
    if (this.sweep) return;
    this.sweep = setInterval(() => this.sweepIdle(), 5_000);
    this.sweep.unref?.();
  }

  close(): void {
    for (const entry of this.entries.values()) {
      this.stop(entry);
      if (entry.bell) clearTimeout(entry.bell);
    }
    this.entries.clear();
    if (this.sweep) clearInterval(this.sweep);
    this.sweep = null;
  }
}
