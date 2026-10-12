import { spawn } from 'node:child_process';
import type { CodeSearchMatch, CodeSearchResult } from '@open-mercato/cezar-contract';

/**
 * Content search for the Code page (spec `.ai/specs/2026-10-11-code-page.md` §5): `git grep` in
 * the checkout, so it sees exactly the index plus untracked-not-ignored files — the same set the
 * tree shows, and never an ignored `.env`. The pattern always follows `-e`; nothing is a shell.
 */

export const SEARCH_MAX_MATCHES = 2_000;
export const SEARCH_MAX_PER_FILE = 200;
export const SEARCH_MAX_LINE = 250;
export const SEARCH_TIMEOUT_MS = 5_000;

export interface CodeSearchInput {
  q: string;
  regex?: boolean;
  caseSensitive?: boolean;
  glob?: string;
}

export type CodeSearchAnswer = { ok: true; result: CodeSearchResult } | { ok: false; error: string };

export function searchCheckout(cwd: string, input: CodeSearchInput, signal?: AbortSignal): Promise<CodeSearchAnswer> {
  const args = [
    'grep', '-n', '-z', '-I', '--untracked', '--no-color',
    `--max-count=${SEARCH_MAX_PER_FILE}`,
    input.regex ? '-E' : '-F',
    ...(input.caseSensitive ? [] : ['-i']),
    '-e', input.q,
    // `:(glob)` so `**` means what a user expects; `:(top)` anchors it at the checkout root.
    ...(input.glob?.trim() ? ['--', `:(top,glob)${input.glob.trim()}`] : []),
  ];
  return new Promise((resolve) => {
    const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    const matches: CodeSearchMatch[] = [];
    let truncated = false;
    let pending = '';
    let stderr = '';
    let settled = false;
    const finish = (answer: CodeSearchAnswer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      child.kill('SIGKILL');
      resolve(answer);
    };
    const stop = () => {
      truncated = true;
      finish({ ok: true, result: { matches, truncated } });
    };
    const abort = () => finish({ ok: true, result: { matches, truncated: true } });
    const timer = setTimeout(stop, SEARCH_TIMEOUT_MS);
    signal?.addEventListener('abort', abort, { once: true });

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      pending += chunk;
      // One record is `path\0line\0text\n`.
      for (;;) {
        const end = pending.indexOf('\n');
        if (end === -1) break;
        const record = pending.slice(0, end);
        pending = pending.slice(end + 1);
        const [path, line, ...rest] = record.split('\0');
        const number = Number(line);
        if (!path || !Number.isInteger(number)) continue;
        if (matches.length >= SEARCH_MAX_MATCHES) return stop();
        matches.push({ path, line: number, text: rest.join('\0').slice(0, SEARCH_MAX_LINE) });
      }
      // A minified line with no newline in sight must not grow the buffer without bound.
      if (pending.length > 1_000_000) pending = '';
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(0, 2_000); });
    child.on('error', (error) => finish({ ok: false, error: error.message }));
    child.on('close', (code) => {
      // 1 is "no match" — an answer, not a failure.
      if (code === 0 || code === 1) return finish({ ok: true, result: { matches, truncated } });
      finish({ ok: false, error: stderr.trim().split('\n')[0]?.replace(/^fatal: /, '') || 'search failed' });
    });
  });
}
