import { z } from 'zod';

/**
 * `POST /api/v1/preview/design-proxy` — Design Mode for the workspace Browser column (spec
 * `.ai/specs/2026-10-09-design-mode.md`).
 *
 * A framed dev server is cross-origin to the cockpit, so the cockpit cannot see which element
 * the user points at. The server answers with a second loopback origin that re-serves the same
 * app with a small picker script injected; the Browser column frames THAT, and the picker
 * reports the clicked element back over `postMessage`.
 *
 * `target` is an ORIGIN, never a page: the proxy mirrors a whole dev server, and the column
 * appends the path itself. `parentOrigin` is the cockpit's own origin — the one window the
 * picker will talk to and listen to. Both must be loopback; the route refuses anything else.
 */
export const designProxyRequestSchema = z.object({
  target: z.string().min(1).max(2048),
  parentOrigin: z.string().min(1).max(512),
});
export type DesignProxyRequest = z.infer<typeof designProxyRequestSchema>;

/** `origin` has no trailing slash and no path, so `origin + pathname` is a loadable address. */
export const designProxyResponseSchema = z.object({
  origin: z.string(),
});
export type DesignProxyResponse = z.infer<typeof designProxyResponseSchema>;

/**
 * `POST /api/v1/preview/gateway` — a task's app, reachable from a HOSTED cockpit (spec
 * `.ai/specs/2026-10-10-preview-gateway.md`).
 *
 * On a hosted cockpit `http://localhost:3000` means the viewer's machine, not the host the task
 * runs on. Where the operator named a pool of ports (`CEZ_PREVIEW_PORTS`), the server re-serves
 * the app on one of them — its own origin, never the cockpit's — and the Browser column frames
 * that instead.
 *
 * `target` is an ORIGIN, as for the design proxy. `parentOrigin` is the cockpit as the viewer's
 * browser reaches it: the gateway is answered at the same scheme and hostname on its own port.
 */
export const previewGatewayRequestSchema = z.object({
  target: z.string().min(1).max(2048),
  parentOrigin: z.string().min(1).max(512),
});
export type PreviewGatewayRequest = z.infer<typeof previewGatewayRequestSchema>;

/**
 * `origin` has no trailing slash and no path. The gateway answers 401 to a browser that holds
 * neither its cookie nor a ticket, so the FIRST load of a page carries `ticket` in the query
 * parameter named by `ticketParam`; the gateway spends it, sets the cookie and redirects to the
 * same address without it. A ticket opens one page load and expires within a minute — ask again
 * before every load, never store one.
 */
export const previewGatewayResponseSchema = z.object({
  origin: z.string(),
  ticket: z.string(),
  ticketParam: z.string(),
});
export type PreviewGatewayResponse = z.infer<typeof previewGatewayResponseSchema>;

/** At most this many notes collect before a task is started from them (spec
 *  `2026-10-24-design-mode-third-cut` §3.2) — the same cap a task's own drafts have. */
export const DESIGN_DRAFTS_MAX = 12;

const px = z.number().int().min(-1_000_000).max(1_000_000);

/**
 * One element picked in Design Mode, as the cockpit keeps it (spec `2026-10-09-design-mode` §3,
 * `2026-10-24-design-mode-third-cut` §3.3). Every field is bounded: it was described by a page
 * cezar does not control and it ends up in a prompt. `source` is where a development build says
 * the element is written, relative to the worktree — never an absolute path.
 */
export const designPickSchema = z.object({
  url: z.string().max(2000),
  selector: z.string().min(1).max(400),
  tag: z.string().min(1).max(40),
  text: z.string().max(200),
  html: z.string().max(1600),
  styles: z.record(z.string().regex(/^[a-z-]{1,40}$/), z.string().max(160)).refine((styles) => Object.keys(styles).length <= 30),
  rect: z.object({ x: px, y: px, width: px, height: px }),
  viewport: z.object({ width: px, height: px }),
  components: z.array(z.string().max(80)).max(6),
  source: z
    .object({
      file: z.string().min(1).max(300).refine((file) => !/^([A-Za-z]:)?[\\/]/.test(file), 'source must be relative'),
      line: z.number().int().positive().optional(),
    })
    .optional(),
  /** The picker's handle on the element in the document it was picked in. */
  mark: z.string().regex(/^[a-z0-9-]{1,24}$/).optional(),
});
export type DesignPick = z.infer<typeof designPickSchema>;

/** A collected note: the element and what the user wrote about it. */
export const designDraftPickSchema = designPickSchema.extend({ note: z.string().max(20_000) });
export type DesignDraftPick = z.infer<typeof designDraftPickSchema>;

/** `GET /repo/design-drafts` — the notes collected with no task chosen, oldest first. */
export const designDraftsResponseSchema = z.object({ picks: z.array(designDraftPickSchema) });
export type DesignDraftsResponse = z.infer<typeof designDraftsResponseSchema>;

/** `PUT /repo/design-drafts` — replace them; an empty list clears them. */
export const setDesignDraftsInputSchema = z.object({ picks: z.array(designDraftPickSchema).max(DESIGN_DRAFTS_MAX) });
export type SetDesignDraftsInput = z.infer<typeof setDesignDraftsInputSchema>;
