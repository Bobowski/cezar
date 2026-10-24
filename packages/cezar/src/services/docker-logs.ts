import { spawn } from 'node:child_process';
import { collectSecretValues, heldSecretStart, lineSafeCut, redactionHold, redactionSafeCut, redactSecretsFrom } from '../core/secret-redaction.ts';

/**
 * `docker logs --timestamps --tail 500 --follow <id>`, one process per container while someone looks (spec
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
/**
 * A line is held whole until its newline and redacted whole; past this it is cut, after redaction —
 * a line still arriving goes out up to a head that splits no secret, and the rest of it is dropped.
 */
const MAX_LINE = 32 * 1024;
const CUT_MARK = ' … [line cut at 32 KiB]';
type Stream = 'out' | 'err';
const BELL_MS = 200;

/** A `--timestamps` line head, RFC 3339 by the daemon's clock: `2026-10-24T10:00:00.123456789Z `. */
const STAMP_RE = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,9}))?(Z|[+-]\d\d:\d\d) /;
/** Longer than any stamp: a line start without one by then has none. */
const STAMP_MAX = 40;

/** One stream's stamps, in ns: the line arriving and the last one passed whole. */
interface Stamps {
  /** Not parsed yet: a line start's stamp still arriving, or inside a line, what may be its stamp again. */
  held: string;
  atStart: boolean;
  /**
   * The open line's stamp as printed. Docker cuts a line past 16 KiB into records, each stamped with
   * the line's first stamp (moby copier `partialTS`): there it is cut out and the records joined.
   */
  mark: string | null;
  open: bigint | null;
  done: bigint | null;
  /** A resumed follower drops the lines stamped at or before this: the killed one had them. */
  after: bigint | null;
  dropping: boolean;
}

function freshStamps(): Stamps {
  return { held: '', atStart: true, mark: null, open: null, done: null, after: null, dropping: false };
}

/** How much of `text`'s tail may be the start of `mark`. */
function markStart(text: string, mark: string | null): number {
  if (mark === null) return 0;
  for (let k = Math.min(mark.length - 1, text.length); k > 0; k--) if (text.endsWith(mark.slice(0, k))) return k;
  return 0;
}

function stampNs(match: RegExpExecArray): bigint | null {
  const ms = Date.parse(`${match[1]}${match[3]}`);
  return Number.isNaN(ms) ? null : BigInt(ms) * 1_000_000n + BigInt((match[2] ?? '').padEnd(9, '0'));
}

function formatStamp(ns: bigint): string {
  const seconds = new Date(Number(ns / 1_000_000_000n) * 1000).toISOString().slice(0, 19);
  return `${seconds}.${(ns % 1_000_000_000n).toString().padStart(9, '0')}Z`;
}

/**
 * `chunk` without its record stamps, each line's noted, the records of one long line joined; a line
 * at or before `after` is dropped.
 */
function unstamp(stamps: Stamps, chunk: string): string {
  let out = '';
  let rest = stamps.held + chunk;
  stamps.held = '';
  while (rest !== '') {
    if (stamps.atStart) {
      const match = STAMP_RE.exec(rest);
      if (match) {
        stamps.open = stampNs(match);
        stamps.mark = match[0];
        stamps.dropping = stamps.open !== null && stamps.after !== null && stamps.open <= stamps.after;
        rest = rest.slice(match[0].length);
      } else if (rest.length < STAMP_MAX && !/[ \n]/.test(rest)) {
        stamps.held = rest;
        break;
      }
      stamps.atStart = false;
      continue;
    }
    const newline = rest.indexOf('\n');
    const line = newline === -1 ? rest : rest.slice(0, newline + 1);
    const record = stamps.mark === null ? -1 : line.indexOf(stamps.mark);
    if (record !== -1) {
      if (!stamps.dropping) out += line.slice(0, record);
      rest = rest.slice(record + stamps.mark!.length);
      continue;
    }
    if (newline === -1) {
      const keep = rest.length - markStart(rest, stamps.mark);
      if (!stamps.dropping) out += rest.slice(0, keep);
      stamps.held = rest.slice(keep);
      break;
    }
    if (!stamps.dropping) out += line;
    if (stamps.open !== null && (stamps.done === null || stamps.open > stamps.done)) stamps.done = stamps.open;
    Object.assign(stamps, { atStart: true, mark: null, open: null, dropping: false });
    rest = rest.slice(newline + 1);
  }
  return out;
}

interface Entry {
  proc: FollowedProcess | null;
  following: boolean;
  text: string;
  /** Cursor of `text[0]`. */
  start: number;
  pending: Record<Stream, string>;
  /** The rest of a cut line is being dropped, up to its newline. */
  skipping: Record<Stream, boolean>;
  /** The dropped line's tail, never shown: a multi-line secret starting in it is still held whole. */
  dropped: Record<Stream, string>;
  /** How many leading chars of `pending` are that tail — held to match a secret, never let out. */
  hidden: Record<Stream, number>;
  holders: number;
  lastRead: number;
  bell: ReturnType<typeof setTimeout> | null;
  stamps: Record<Stream, Stamps>;
  /** The `--since` a follower we killed is picked up from; `null` once Docker ended it. */
  resumeFrom: string | null;
}

/** Forget every byte held for a follower — a line still arriving, a secret still being held. */
function clearHold(entry: Entry): void {
  entry.pending = { out: '', err: '' };
  entry.skipping = { out: false, err: false };
  entry.dropped = { out: '', err: '' };
  entry.hidden = { out: 0, err: 0 };
  entry.stamps = { out: freshStamps(), err: freshStamps() };
}

/**
 * What a killed process held never joins the next one's output — a half-held secret would leak — but
 * kept hidden, it lets a resumed follower still match a secret the killed one was printing. Returns
 * the stamp to resume from: the line each stream had open (sent again — a partial one is shown whole,
 * one being dropped stays dropped), else its last whole line, which the resumed follower skips.
 */
function hideHold(entry: Entry): bigint | null {
  let since: bigint | null = null;
  for (const stream of ['out', 'err'] as const) {
    const stamps = entry.stamps[stream];
    let held = entry.skipping[stream] ? entry.dropped[stream] : entry.pending[stream];
    stamps.after = stamps.done;
    if (stamps.open !== null && entry.skipping[stream]) {
      held += '\n';
      stamps.after = stamps.open;
    } else if (stamps.open !== null) {
      held = held.slice(0, held.lastIndexOf('\n') + 1);
    }
    const need = stamps.open ?? stamps.done;
    if (need !== null && (since === null || need < since)) since = need;
    Object.assign(stamps, { held: '', atStart: true, mark: null, open: null, dropping: false });
    entry.pending[stream] = held;
    entry.hidden[stream] = held.length;
    entry.skipping[stream] = false;
    entry.dropped[stream] = '';
  }
  return since;
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

  private secretValues(): readonly string[] {
    return this.options.secrets?.() ?? collectSecretValues();
  }

  private redacting(): boolean {
    return process.env.CEZ_REDACT_SECRETS !== '0';
  }

  /** `text` redacted as a whole but shown from `hidden` on: a secret reaching past it still goes. */
  private redact(text: string, values: readonly string[], hidden = 0): string {
    return this.redacting() ? redactSecretsFrom(text, values, hidden, { chunkEdges: true }) : text.slice(hidden);
  }

  /** Redacted text, each line cut to `MAX_LINE` — after redaction, so the cut splits no secret. */
  private capped(text: string, values: readonly string[], hidden = 0): string {
    return this.redact(text, values, hidden).split('\n').map((line) => (line.length > MAX_LINE ? line.slice(0, MAX_LINE) + CUT_MARK : line)).join('\n');
  }

  /** What a read lets out: whole lines, redacted whole; of a line past the cap, its head and a mark. */
  private take(entry: Entry, stream: Stream, chunk: string): string {
    let text = chunk;
    const values = this.redacting() ? this.secretValues() : [];
    if (entry.skipping[stream]) {
      const newline = text.indexOf('\n');
      const dropped = entry.dropped[stream] + (newline === -1 ? text : text.slice(0, newline + 1));
      if (newline === -1) {
        entry.dropped[stream] = dropped.slice(-redactionHold(values));
        return '';
      }
      // The cut line ended: a secret whose first line ended it is held on, hidden, with what follows.
      const held = heldSecretStart(dropped, values);
      entry.skipping[stream] = false;
      entry.dropped[stream] = '';
      entry.pending[stream] = dropped.slice(held);
      entry.hidden[stream] = dropped.length - held;
      text = text.slice(newline + 1);
    }
    const pending = entry.pending[stream] + text;
    const hidden = entry.hidden[stream];
    // Not past a tail a multi-line secret (a PEM) may still be arriving in, nor into one whose last
    // line has not ended: it is redacted whole too.
    const cut = lineSafeCut(pending, values, Math.min(pending.lastIndexOf('\n') + 1, heldSecretStart(pending, values)));
    const out = this.capped(pending.slice(0, cut), values, hidden);
    const rest = pending.slice(cut);
    const restHidden = Math.max(0, hidden - cut);
    if (rest.length <= MAX_LINE + redactionHold(values)) {
      entry.pending[stream] = rest;
      entry.hidden[stream] = restHidden;
      return out;
    }
    // Never a flush of the held line: a secret its last read ended inside would go out half-redacted.
    const head = this.redacting() ? redactionSafeCut(rest, values, MAX_LINE) : MAX_LINE;
    entry.pending[stream] = '';
    entry.hidden[stream] = 0;
    entry.skipping[stream] = true;
    // From the head's tail on: a secret's first line may straddle the cut.
    entry.dropped[stream] = rest.slice(-redactionHold(values));
    return `${out}${this.redact(rest.slice(0, head), values, restHidden)}${CUT_MARK}\n`;
  }

  private entry(id: string): Entry {
    let entry = this.entries.get(id);
    if (!entry) {
      entry = { proc: null, following: false, text: '', start: 0, pending: { out: '', err: '' }, skipping: { out: false, err: false }, dropped: { out: '', err: '' }, hidden: { out: 0, err: 0 }, holders: 0, lastRead: this.now(), bell: null, stamps: { out: freshStamps(), err: freshStamps() }, resumeFrom: null };
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
      clearHold(entry);
    }
    entry.resumeFrom = null;
    entry.following = true;
    const from = !fresh && since !== null ? ['--since', since] : ['--tail', String(TAIL_LINES)];
    // Stamped by the daemon, so a resume never leans on the host clock agreeing with it.
    const proc = this.spawnDocker(['logs', '--timestamps', ...from, '--follow', id], {
      data: (stream, chunk) => {
        if (entry.proc !== proc) return;
        // Whole lines only, so a secret split across two chunks is still one string when redacted.
        this.append(id, entry, this.take(entry, stream, unstamp(entry.stamps[stream], chunk)));
      },
      exit: (reason) => {
        if (entry.proc !== proc) return;
        // A line start still waiting to show it carries no stamp, or a record stamp to show it is one, is text.
        for (const stream of ['out', 'err'] as const) {
          const stamps = entry.stamps[stream];
          this.append(id, entry, this.take(entry, stream, stamps.dropping ? '' : stamps.held));
        }
        const values = this.redacting() ? this.secretValues() : [];
        // A partial last line goes out; a multi-line secret it may be the start of does not.
        const rest = (['out', 'err'] as const).map((stream) => {
          const pending = entry.pending[stream];
          return entry.skipping[stream] ? '' : this.capped(pending.slice(0, heldSecretStart(pending, values)), values, entry.hidden[stream]);
        }).join('');
        clearHold(entry);
        this.append(id, entry, rest + (reason ? `\n[${reason}]\n` : ''));
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
    // Cut off by us, not ended by Docker: a returning reader resumes from here, by the daemon's stamps.
    const since = hideHold(entry);
    entry.resumeFrom = since === null ? new Date(this.now()).toISOString() : formatStamp(since);
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
