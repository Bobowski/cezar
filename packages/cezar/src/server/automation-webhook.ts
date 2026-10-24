import { rmSync } from 'node:fs';
import { Hono, type Context, type Next } from 'hono';
import { z } from 'zod';
import type { AutomationWebhook } from '@open-mercato/cezar-contract';
import type { AutomationStore } from '../automations/store.ts';
import { isGithubAutomation } from '../automations/types.ts';
import {
  deleteGithubHook,
  isWebhookId,
  newWebhookIdentity,
  pingGithubHook,
  readWebhook,
  registerGithubHook,
  sameHookId,
  verifySignature,
  MIN_WAKE_POLL_MS,
  WakeThrottle,
  webhookPath,
  writeWebhook,
  type GhJsonRun,
  type WebhookFile,
} from '../automations/webhook.ts';
import type { ProjectContext } from './project-context.ts';
import { paramZodValidator } from './validators.ts';

/**
 * The webhook wake-up's two route families (spec 2026-10-23-github-events §4): the public
 * `POST /hooks/:sender/:hookId` GitHub calls, and the project's `automation-webhook` routes the
 * Automations page registers, pings and removes it with. Namespaced by sender from the start —
 * a later sender is a new `:sender`, never a new route.
 */

type ProjectApiEnv = { Variables: { project: ProjectContext } };

/** What a delivery needs of its project: where the hook file lives, and how to wake it. */
export interface HookProject {
  id: string;
  dataDir: string;
}

const hookParamsSchema = z.object({ sender: z.string(), hookId: z.string() });

const webhookLocks = new Map<string, Promise<unknown>>();
const githubHookOps = new Map<string, Promise<unknown>>();

async function inTurn<T>(locks: Map<string, Promise<unknown>>, key: string, fn: () => T | Promise<T>): Promise<T> {
  const turn = (locks.get(key) ?? Promise.resolve()).then(fn, fn);
  const tail = turn.catch(() => undefined);
  locks.set(key, tail);
  try {
    return await turn;
  } finally {
    if (locks.get(key) === tail) locks.delete(key);
  }
}

/** One project's webhook-file mutations, one at a time: each re-reads the file inside, so a
 *  request that read it before an await never writes back what another one changed meanwhile. */
export function withWebhookLock<T>(dataDir: string, fn: () => T | Promise<T>): Promise<T> {
  return inTurn(webhookLocks, dataDir, fn);
}

/** Register, ping and remove, one at a time per project. Their `gh api` awaits stay outside
 *  the file lock, so a delivery's bookkeeping never waits on GitHub. */
function withGithubHookOp<T>(dataDir: string, fn: () => T | Promise<T>): Promise<T> {
  return inTurn(githubHookOps, dataDir, fn);
}

/**
 * Due now — or a minute after its last poll (`MIN_WAKE_POLL_MS`), so a burst of deliveries is one
 * trailing poll — for every enabled GitHub poll of the project that is not backed off. `wakeAt` is
 * stamped on one already due as well, so a poll in flight sees that a wake arrived and its
 * `persist` keeps it due soon instead of pushing it out a whole interval. Returns how many moved
 * earlier.
 */
export function wakeGithubPolls(store: AutomationStore, now = Date.now()): number {
  const at = new Date(now).toISOString();
  let woke = 0;
  for (const definition of store.list()) {
    if (!definition.enabled || !isGithubAutomation(definition)) continue;
    const state = store.state(definition.id);
    if (state?.backoffUntil && Date.parse(state.backoffUntil) > now) continue;
    const lastPoll = state?.lastSuccessAt ? Date.parse(state.lastSuccessAt) : Number.NaN;
    const target = Number.isFinite(lastPoll) ? Math.max(now, lastPoll + MIN_WAKE_POLL_MS) : now;
    const scheduled = state?.nextCheckAt ? Date.parse(state.nextCheckAt) : Number.POSITIVE_INFINITY;
    const sooner = !(scheduled <= target);
    store.setState(definition.id, (current) => ({ ...current, wakeAt: at, ...(sooner ? { nextCheckAt: new Date(target).toISOString() } : {}) }));
    if (sooner) woke += 1;
  }
  return woke;
}

/**
 * hookId → project, over every project's `github-webhook.json`. An unknown id rescans at most
 * once per `rescanMs`, so a stream of forged ids costs reads of a handful of small files, not one
 * scan per request.
 */
export class HookIndex {
  private readonly byId = new Map<string, HookProject>();
  private scannedAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly projects: () => Promise<readonly HookProject[]>,
    private readonly rescanMs = 10_000,
    private readonly now = () => Date.now(),
  ) {}

  async find(hookId: string): Promise<HookProject | undefined> {
    const known = this.byId.get(hookId);
    if (known) return known;
    if (this.now() - this.scannedAt < this.rescanMs) return undefined;
    this.scannedAt = this.now();
    this.byId.clear();
    for (const project of await this.projects().catch(() => [])) {
      const file = readWebhook(project.dataDir);
      if (file) this.byId.set(file.hookId, project);
    }
    return this.byId.get(hookId);
  }

  /** A hook was registered or removed: the next lookup reads the files again. */
  forget(): void {
    this.byId.clear();
    this.scannedAt = Number.NEGATIVE_INFINITY;
  }
}

/** Keep the family chained: this return value is part of AppType and the typed client. */
export function hookRoutes(deps: {
  find: (hookId: string) => Promise<HookProject | undefined>;
  wake: (project: HookProject) => void | Promise<void>;
  throttle?: WakeThrottle;
  /** The automations capability: off (`CEZ_AUTOMATIONS=0`), no hook exists to call. */
  enabled?: () => boolean;
}) {
  const throttle = deps.throttle ?? new WakeThrottle();
  return new Hono().post('/hooks/:sender/:hookId', paramZodValidator(hookParamsSchema), async (c) => {
    const { sender, hookId } = c.req.valid('param');
    if (deps.enabled && !deps.enabled()) return c.json({ error: 'not found' }, 404);
    // The id is the first factor: anything that does not name a stored hook is a 404.
    if (sender !== 'github' || !isWebhookId(hookId)) return c.json({ error: 'not found' }, 404);
    const project = await deps.find(hookId);
    const file = project ? readWebhook(project.dataDir) : undefined;
    if (!project || !file || !sameHookId(file.hookId, hookId)) return c.json({ error: 'not found' }, 404);
    // The raw bytes, for the signature only — never parsed, so a malformed body still wakes.
    const body = new Uint8Array(await c.req.arrayBuffer());
    if (!verifySignature(file.secret, body, c.req.header('x-hub-signature-256'))) {
      return c.json({ error: 'signature mismatch' }, 401);
    }
    const event = (c.req.header('x-github-event') ?? '').replace(/[^\w.-]/g, '').slice(0, 100);
    const deliveryId = (c.req.header('x-github-delivery') ?? '').replace(/[^\w.-]/g, '').slice(0, 100);
    const now = new Date().toISOString();
    // Bookkeeping only: a hook removed or re-registered meanwhile is never written back.
    const record = (patch: (current: WebhookFile) => WebhookFile) => withWebhookLock(project.dataDir, () => {
      const current = readWebhook(project.dataDir);
      if (current && sameHookId(current.hookId, hookId)) writeWebhook(project.dataDir, patch(current));
    }).catch(() => undefined);
    // A ping proves the route; it has nothing for a poll to find.
    const woke = event !== 'ping' && throttle.take(project.dataDir);
    // Not awaited: waking may build a project context, and GitHub gives a delivery ten seconds.
    const fire = () => { void Promise.resolve().then(() => deps.wake(project)).catch(() => undefined); };
    if (woke) fire();
    else if (event !== 'ping') {
      throttle.trail(project.dataDir, () => {
        fire();
        void record((current) => ({ ...current, lastWakeAt: new Date().toISOString() }));
      });
    }
    await record((current) => ({
      ...current,
      lastDeliveryAt: now,
      ...(event ? { lastEvent: event } : {}),
      ...(deliveryId ? { lastDeliveryId: deliveryId } : {}),
      ...(woke ? { lastWakeAt: now } : {}),
      ...(event === 'ping' ? { ping: { at: now, ok: true } } : {}),
    }));
    return c.json({ accepted: true as const, woke }, 202);
  });
}

export interface WebhookRouteDeps {
  /** The automations capability (`CEZ_AUTOMATIONS=0` turns it off); off, every route 409s. */
  enabled: () => boolean;
  offMessage: string;
  /** Hosted, with cezar's own sign-in — the only cockpit that may register a public hook. */
  canRegister: () => { ok: true } | { ok: false; reason: string };
  /** The cockpit's public origin as this request reached it (hosted mode), else undefined. */
  publicOrigin: (headers: { host?: string; proto?: string }) => string | undefined;
  /** The project's GitHub remote, or why there is none. */
  remote: (root: string) => Promise<{ owner: string; repo: string; host: string } | undefined>;
  /** A hook was registered or removed. */
  changed: () => void;
  run?: GhJsonRun;
  /** `CEZ_DRY_RUN=1`: nothing is sent to GitHub. */
  dryRun?: () => boolean;
}

/** `/api/v1/hooks/github/<id>`, or its shape before one exists. */
function routeOf(hookId: string | undefined): string {
  return `/api/v1/hooks/github/${hookId ?? '<hook-id>'}`;
}

/** Keep the family chained: this return value is part of AppType and the typed client. */
export function automationWebhookRoutes(deps: WebhookRouteDeps) {
  const status = async (project: ProjectContext, origin: string | undefined): Promise<AutomationWebhook> => {
    const file = readWebhook(project.dataDir);
    const allowed = deps.canRegister();
    const remote = allowed.ok && origin ? await deps.remote(project.root) : undefined;
    const reason = !allowed.ok ? allowed.reason
      : !origin ? 'This cockpit does not know a public URL GitHub could call.'
        : !remote ? 'This project has no GitHub remote.'
          : undefined;
    const registered = file?.githubHookId !== undefined;
    return {
      available: reason === undefined,
      ...(reason ? { reason } : {}),
      route: routeOf(file?.hookId),
      ...(origin && file ? { url: `${origin}${routeOf(file.hookId)}` } : {}),
      registered,
      ...(registered && file?.registeredAt ? { registeredAt: file.registeredAt } : {}),
      ...(file?.lastDeliveryAt ? { lastDeliveryAt: file.lastDeliveryAt } : {}),
      ...(file?.lastEvent ? { lastEvent: file.lastEvent } : {}),
      ...(file?.lastWakeAt ? { lastWakeAt: file.lastWakeAt } : {}),
      ...(file?.ping ? { ping: { at: file.ping.at, ok: file.ping.ok, ...(file.ping.error ? { error: file.ping.error } : {}) } } : {}),
    };
  };
  const originOf = (c: { req: { header: (name: string) => string | undefined } }) =>
    deps.publicOrigin({ host: c.req.header('host'), proto: c.req.header('x-forwarded-proto') });
  const failure = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 500);

  // Explicit paths, never `use('*')`: this family is mounted with `.route('/', …)` beside others.
  const gate = async (c: Context, next: Next) => {
    if (!deps.enabled()) return c.json({ error: deps.offMessage }, 409);
    await next();
  };
  return new Hono<ProjectApiEnv>()
    .use('/automation-webhook', gate)
    .use('/automation-webhook/*', gate)
    .get('/automation-webhook', async (c) => c.json({ webhook: await status(c.get('project'), originOf(c)) }))

    // Register (or re-register at a new URL): a fresh id and secret, written BEFORE GitHub is
    // asked, because GitHub pings the hook the moment it exists. A previous file comes back if
    // GitHub refuses, and its hook is removed only once the new one exists.
    .post('/automation-webhook', async (c) => {
      const project = c.get('project');
      const origin = originOf(c);
      const current = await status(project, origin);
      if (!current.available || !origin) return c.json({ error: current.reason ?? 'webhooks are unavailable here' }, 409);
      const remote = (await deps.remote(project.root))!;
      const { dataDir } = project;
      return withGithubHookOp(dataDir, async () => {
        const identity = newWebhookIdentity();
        const url = `${origin}${routeOf(identity.hookId)}`;
        const ours = () => {
          const file = readWebhook(dataDir);
          return file && sameHookId(file.hookId, identity.hookId) ? file : undefined;
        };
        const previous = await withWebhookLock(dataDir, () => {
          const file = readWebhook(dataDir);
          if (file?.githubHookId !== undefined && file.url === `${origin}${routeOf(file.hookId)}`) return { unchanged: true as const };
          writeWebhook(dataDir, { version: 1, ...identity, repo: `${remote.owner}/${remote.repo}`, url });
          return { file };
        });
        if ('unchanged' in previous) return c.json({ webhook: current });
        deps.changed();
        try {
          const githubHookId = deps.dryRun?.() ? 1 : await registerGithubHook({ ...remote, url, secret: identity.secret, run: deps.run });
          // Re-read: the ping GitHub sent meanwhile has been recorded into this file.
          await withWebhookLock(dataDir, () => {
            const file = ours();
            if (file) writeWebhook(dataDir, { ...file, githubHookId, registeredAt: new Date().toISOString() });
          });
        } catch (error) {
          // The hook GitHub already has keeps its file: losing `githubHookId` would orphan it.
          await withWebhookLock(dataDir, () => {
            if (!ours()) return;
            if (previous.file) writeWebhook(dataDir, previous.file);
            else rmSync(webhookPath(dataDir), { force: true });
          });
          deps.changed();
          return c.json({ error: `GitHub refused the webhook: ${failure(error)}` }, 409);
        }
        if (previous.file?.githubHookId !== undefined && !deps.dryRun?.()) {
          // Best-effort: an old hook that survives calls a route id no file holds any more (a 404).
          await deleteGithubHook({ ...remote, githubHookId: previous.file.githubHookId, run: deps.run }).catch(() => undefined);
        }
        return c.json({ webhook: await status(project, origin) });
      });
    })

    .post('/automation-webhook/ping', async (c) => {
      const project = c.get('project');
      const { dataDir } = project;
      return withGithubHookOp(dataDir, async () => {
        const file = readWebhook(dataDir);
        if (file?.githubHookId === undefined) return c.json({ error: 'no webhook is registered' }, 409);
        const remote = await deps.remote(project.root);
        if (!remote) return c.json({ error: 'This project has no GitHub remote.' }, 409);
        const at = new Date().toISOString();
        let ping: { at: string; ok: boolean; error?: string };
        try {
          if (!deps.dryRun?.()) await pingGithubHook({ ...remote, githubHookId: file.githubHookId, run: deps.run });
          ping = { at, ok: true };
        } catch (error) {
          ping = { at, ok: false, error: failure(error) };
        }
        await withWebhookLock(dataDir, () => {
          const now = readWebhook(dataDir);
          if (now && sameHookId(now.hookId, file.hookId)) writeWebhook(dataDir, { ...now, ping });
        });
        return c.json({ webhook: await status(project, originOf(c)) });
      });
    })

    .delete('/automation-webhook', async (c) => {
      const project = c.get('project');
      const { dataDir } = project;
      return withGithubHookOp(dataDir, async () => {
        const file = readWebhook(dataDir);
        if (file?.githubHookId !== undefined && !deps.dryRun?.()) {
          const remote = await deps.remote(project.root);
          if (remote) {
            try { await deleteGithubHook({ ...remote, githubHookId: file.githubHookId, run: deps.run }); }
            catch (error) { return c.json({ error: `GitHub refused to remove the webhook: ${failure(error)}` }, 409); }
          }
        }
        await withWebhookLock(dataDir, () => rmSync(webhookPath(dataDir), { force: true }));
        deps.changed();
        return c.json({ webhook: await status(project, originOf(c)) });
      });
    });
}
