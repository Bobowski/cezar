import { spawn } from 'node:child_process';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { atomicWriteJsonSync } from '../workspace/config.ts';

/**
 * The GitHub webhook WAKE-UP (spec 2026-10-23-github-events §4). A delivery carries nothing cezar
 * acts on: the signature is checked, the event name and delivery id are noted, the payload is
 * thrown away and the project's polls run now instead of at `nextCheckAt`. The poll stays the
 * one source of truth, so a lost delivery costs latency, never an event.
 *
 * State is one gitignored file per project, `.ai/cezar/github-webhook.json`: the route id (the
 * first factor), the HMAC secret (the second), what GitHub registered, and the last delivery.
 * Delete it and the hook is simply unregistered from cezar's side.
 */

export const WEBHOOK_FILE = 'github-webhook.json';
/** One wake per project per window; deliveries inside it collapse into the wake already done. */
export const WAKE_WINDOW_MS = 5_000;
/** What GitHub is asked to send — the events the poll sources read, nothing else. */
export const WEBHOOK_EVENTS = [
  'pull_request', 'pull_request_review', 'pull_request_review_comment', 'issue_comment',
  'issues', 'check_suite', 'push', 'release',
] as const;
const HOOK_ID_RE = /^[0-9a-f]{64}$/;

export const webhookFileSchema = z
  .object({
    version: z.literal(1).default(1),
    hookId: z.string().regex(HOOK_ID_RE),
    secret: z.string().min(32),
    /** GitHub's own id for the hook, once registered. */
    githubHookId: z.number().int().positive().optional(),
    repo: z.string().optional(),
    url: z.string().optional(),
    registeredAt: z.string().optional(),
    lastDeliveryAt: z.string().optional(),
    lastEvent: z.string().max(100).optional(),
    lastDeliveryId: z.string().max(100).optional(),
    lastWakeAt: z.string().optional(),
    ping: z.object({ at: z.string(), ok: z.boolean(), error: z.string().max(500).optional() }).optional(),
  })
  .passthrough();
export type WebhookFile = z.infer<typeof webhookFileSchema>;

export function webhookPath(dataDir: string): string {
  return join(dataDir, WEBHOOK_FILE);
}

/** The stored hook, or undefined — a missing or unreadable file is "no hook", never an error. */
export function readWebhook(dataDir: string): WebhookFile | undefined {
  try {
    const parsed = webhookFileSchema.safeParse(JSON.parse(readFileSync(webhookPath(dataDir), 'utf8')));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export function writeWebhook(dataDir: string, file: WebhookFile): void {
  atomicWriteJsonSync(webhookPath(dataDir), file);
}

/** A fresh route id and secret: 32 random bytes each. */
export function newWebhookIdentity(): Pick<WebhookFile, 'hookId' | 'secret'> {
  return { hookId: randomBytes(32).toString('hex'), secret: randomBytes(32).toString('hex') };
}

export function isWebhookId(value: string): boolean {
  return HOOK_ID_RE.test(value);
}

/** Constant-time equality of two route ids. */
export function sameHookId(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** `X-Hub-Signature-256: sha256=<hex>` over the raw body, compared in constant time. */
export function verifySignature(secret: string, body: Uint8Array, header: string | undefined): boolean {
  const match = /^sha256=([0-9a-f]{64})$/i.exec(header?.trim() ?? '');
  if (!match) return false;
  const expected = createHmac('sha256', secret).update(body).digest();
  const given = Buffer.from(match[1]!, 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** `gh` with a JSON body on stdin — the secret never rides an argument list. */
export type GhJsonRun = (args: readonly string[], stdin?: string) => Promise<string>;

export const defaultGhRun: GhJsonRun = (args, stdin) => new Promise((resolve, reject) => {
  const child = spawn('gh', [...args], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let stdout = '';
  let stderr = '';
  const timer = setTimeout(() => child.kill(), 30_000);
  child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
  child.on('error', (error) => { clearTimeout(timer); reject(error); });
  child.on('close', (code) => {
    clearTimeout(timer);
    if (code === 0) resolve(stdout);
    else reject(Object.assign(new Error((stderr || stdout).trim().split('\n')[0] || `gh exited ${code}`), { stdout, stderr }));
  });
  child.stdin.end(stdin ?? '');
});

const withHost = (host: string | undefined, args: string[]) =>
  host && host.toLowerCase() !== 'github.com' ? ['api', '--hostname', host, ...args.slice(1)] : args;

/** `POST repos/<o>/<r>/hooks` with the user's own `gh` auth; GitHub's hook id. */
export async function registerGithubHook(input: {
  owner: string; repo: string; host?: string; url: string; secret: string; run?: GhJsonRun;
}): Promise<number> {
  const run = input.run ?? defaultGhRun;
  const body = JSON.stringify({
    name: 'web', active: true, events: WEBHOOK_EVENTS,
    config: { url: input.url, content_type: 'json', secret: input.secret, insecure_ssl: '0' },
  });
  const raw = await run(withHost(input.host, ['api', '--method', 'POST', `repos/${input.owner}/${input.repo}/hooks`, '--input', '-']), body);
  const id = z.object({ id: z.number().int().positive() }).passthrough().parse(JSON.parse(raw)).id;
  return id;
}

/** `POST …/hooks/<id>/pings` — GitHub answers 204 and then delivers a `ping` event. */
export async function pingGithubHook(input: { owner: string; repo: string; host?: string; githubHookId: number; run?: GhJsonRun }): Promise<void> {
  const run = input.run ?? defaultGhRun;
  await run(withHost(input.host, ['api', '--method', 'POST', `repos/${input.owner}/${input.repo}/hooks/${input.githubHookId}/pings`]));
}

/** `DELETE …/hooks/<id>`; a hook already gone on GitHub is fine. */
export async function deleteGithubHook(input: { owner: string; repo: string; host?: string; githubHookId: number; run?: GhJsonRun }): Promise<void> {
  const run = input.run ?? defaultGhRun;
  try {
    await run(withHost(input.host, ['api', '--method', 'DELETE', `repos/${input.owner}/${input.repo}/hooks/${input.githubHookId}`]));
  } catch (error) {
    if (!/\b404\b|Not Found/.test(`${error instanceof Error ? error.message : String(error)} ${String((error as { stderr?: unknown }).stderr ?? '')}`)) throw error;
  }
}

/** Per-project wake throttle: `true` when this delivery may wake, `false` when it collapses. */
export class WakeThrottle {
  private readonly last = new Map<string, number>();
  constructor(private readonly windowMs = WAKE_WINDOW_MS, private readonly now = () => Date.now()) {}

  take(key: string): boolean {
    const at = this.now();
    const previous = this.last.get(key);
    if (previous !== undefined && at - previous < this.windowMs) return false;
    this.last.set(key, at);
    // Bounded: forget windows long closed so a busy workspace cannot grow the map.
    if (this.last.size > 1_000) {
      for (const [other, when] of this.last) if (at - when >= this.windowMs) this.last.delete(other);
    }
    return true;
  }
}
