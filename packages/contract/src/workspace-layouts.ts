import { z } from 'zod';

/**
 * A task's saved workspace layouts (spec `.ai/specs/2026-10-07-task-workspace.md` §5.2, §5.3).
 *
 * The wire shape of what the cockpit builds in the view area, persisted by the cezar that owns
 * the task — §5.3: "Persist named layouts per task on the Cezar host that owns the task."
 *
 * Every axis is bounded, because this body is written straight to a file on the host: three
 * columns is the spec's own cap (§5.2), and the rest are sized so a hand-written request cannot
 * turn the store into a dumping ground.
 */

/** The surfaces a column can show. `terminal` is deliberately absent — it is the bottom drawer,
 *  not a column (§5.1). Kept in step with the cockpit's own `ViewId`. */
export const workspaceViewSchema = z.enum(['session', 'changes', 'commits', 'files', 'browser', 'graph', 'terminal']);
export type WorkspaceView = z.infer<typeof workspaceViewSchema>;

/** The bounds, exported so the cockpit enforces the SAME ones where state grows: the whole
 *  document is validated per PUT, so one over-limit value fails every later save. */
export const MAX_WORKSPACE_COLUMNS = 3;
export const MAX_WORKSPACE_BROWSER_TABS = 12;
export const MAX_WORKSPACE_TAB_URL_LENGTH = 2048;
export const MAX_WORKSPACE_LAYOUT_NAME_LENGTH = 80;

/** A Browser column's own tabs (§7). Only successfully loaded addresses are stored, so these are
 *  plain strings; an empty string IS a blank tab. */
export const workspaceBrowserSchema = z.object({
  tabs: z.array(z.string().max(MAX_WORKSPACE_TAB_URL_LENGTH)).max(MAX_WORKSPACE_BROWSER_TABS),
  active: z.number().int().min(0).max(MAX_WORKSPACE_BROWSER_TABS - 1),
});
export type WorkspaceBrowserState = z.infer<typeof workspaceBrowserSchema>;

export const workspaceColumnSchema = z.object({
  view: workspaceViewSchema,
  /** Percent of the row. The cockpit normalises these on read, so a stored set that does not sum
   *  to 100 is recoverable rather than rejected. */
  width: z.number().finite().min(0).max(100),
  browser: workspaceBrowserSchema.optional(),
});
export type WorkspaceColumnState = z.infer<typeof workspaceColumnSchema>;

/** A layout holds ZERO to three columns — zero because §10 says "A saved layout may
 *  intentionally have no columns", which is the shape closing the last column leaves behind. */
export const workspaceLayoutSchema = z.object({
  name: z.string().min(1).max(MAX_WORKSPACE_LAYOUT_NAME_LENGTH),
  columns: z.array(workspaceColumnSchema).max(MAX_WORKSPACE_COLUMNS),
});
export type WorkspaceLayoutState = z.infer<typeof workspaceLayoutSchema>;

/** A backstop on cards per task. Far above any real strip (which folds past six into a menu),
 *  low enough that a loop cannot grow the file without bound. */
export const MAX_WORKSPACE_LAYOUTS = 50;

export const workspaceLayoutsSchema = z.object({
  layouts: z.array(workspaceLayoutSchema).max(MAX_WORKSPACE_LAYOUTS),
  /** The active card's name. May name a layout that is gone — the cockpit recovers rather than
   *  failing, so this is not cross-validated here. */
  active: z.string().max(MAX_WORKSPACE_LAYOUT_NAME_LENGTH),
});
export type WorkspaceLayouts = z.infer<typeof workspaceLayoutsSchema>;

/**
 * `GET /runs/:id/layouts`.
 *
 * `layouts: null` means this task has never been opened, which is NOT the same as an empty list:
 * an empty list is a workspace the user emptied on purpose and §5.3 keeps it empty for the visit,
 * while "never opened" is what the cockpit answers with a fresh `Czat` card.
 */
export const workspaceLayoutsResponseSchema = z.object({
  layouts: workspaceLayoutsSchema.nullable(),
});
export type WorkspaceLayoutsResponse = z.infer<typeof workspaceLayoutsResponseSchema>;

/**
 * A layout the user SAVED by name — workspace-wide, so it is offered in every task of every
 * project (`savedLayouts` in `~/.cezar/ui-state.json`). Only the arrangement travels: which views,
 * how wide. A column's own state (a Preview's tabs) belongs to the task it was opened in.
 */
export const MAX_SAVED_WORKSPACE_LAYOUTS = 50;
export const savedWorkspaceLayoutSchema = z.object({
  name: z.string().trim().min(1).max(MAX_WORKSPACE_LAYOUT_NAME_LENGTH),
  columns: z
    .array(z.object({ view: workspaceViewSchema, width: z.number().finite().min(0).max(100) }))
    .min(1)
    .max(MAX_WORKSPACE_COLUMNS),
});
export type SavedWorkspaceLayout = z.infer<typeof savedWorkspaceLayoutSchema>;

/**
 * The Code page's Browser tabs (spec `.ai/specs/2026-10-24-code-page-browser-tabs.md` §3–4): each
 * open page's address and place, per checkout, so a reload or another device brings them back.
 *
 * Kept under `codePages` in the per-repo ui-state (`GET/PUT /ui-state`), not in the task layouts
 * above: the Code page is the project's, not a task's. Only LOOPBACK addresses are stored (§5) —
 * a gateway origin is a port this session was handed, and its loopback twin gets a fresh ticket
 * on restore. Sized so the whole value stays under the ui-state body limit.
 */
export const MAX_CODE_PAGES = 12;
export const MAX_CODE_PAGE_TREES = 8;
export const MAX_CODE_PAGE_URL_LENGTH = 1024;

const OCTET = '(25[0-5]|2[0-4]\\d|1?\\d?\\d)';
/** `localhost`, `*.localhost`, 127.0.0.0/8 and `[::1]` — anchored, so `127.0.0.1.example.com` is not one. */
const LOOPBACK_HOSTNAME = new RegExp(`^(localhost|([a-z0-9-]+\\.)+localhost|127\\.${OCTET}\\.${OCTET}\\.${OCTET}|\\[::1\\])$`, 'i');

export const codePageUrlSchema = z
  .url({ protocol: /^https?$/, hostname: LOOPBACK_HOSTNAME })
  .max(MAX_CODE_PAGE_URL_LENGTH)
  .refine((url) => !/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*@/i.test(url), 'no credentials in a page address');

/** An http(s) loopback address with no credentials — what a Code Browser tab may persist. */
export const isLoopbackPageAddress = (url: string): boolean => codePageUrlSchema.safeParse(url).success;

export const codePageSchema = z.object({
  /** The tab's id in the Code layout (`browser:<id>`). */
  id: z.string().regex(/^[a-z0-9]{1,16}$/),
  url: codePageUrlSchema,
  /** The editor group it sits in, left to right. */
  group: z.number().int().min(0).max(3),
});
export type CodePage = z.infer<typeof codePageSchema>;

/** One checkout's pages, in order. An EMPTY list is "none open", which is not "never saved". */
export const codePagesTreeSchema = z.object({
  /** `main`, or a task's run id. */
  tree: z.string().min(1).max(64),
  pages: z.array(codePageSchema).max(MAX_CODE_PAGES),
});
export type CodePagesTree = z.infer<typeof codePagesTreeSchema>;

/** Most recently written checkout first. */
export const codePagesSchema = z.array(codePagesTreeSchema).max(MAX_CODE_PAGE_TREES);
export type CodePages = z.infer<typeof codePagesSchema>;

/**
 * The Git page's sidebar (spec `.ai/specs/2026-10-24-cockpit-polish.md` §3.1, §4): its width in
 * CSS pixels and whether it is folded to icons. Per project, under `repo` in the per-repo
 * ui-state, beside the Code page's `codePages` — the same "layout of a project screen" family.
 */
export const MIN_REPO_SIDEBAR_WIDTH = 220;
export const MAX_REPO_SIDEBAR_WIDTH = 560;
/** The shell's own contextual column (18rem). */
export const DEFAULT_REPO_SIDEBAR_WIDTH = 288;
export const repoLayoutSchema = z.object({
  width: z.number().int().min(MIN_REPO_SIDEBAR_WIDTH).max(MAX_REPO_SIDEBAR_WIDTH),
  collapsed: z.boolean(),
});
export type RepoLayout = z.infer<typeof repoLayoutSchema>;

/**
 * A task's Browser column's share of the workspace row, in percent (§3.2): what a NEW Browser
 * column opens at, remembered per project from the last divider drag. Absent → 45.
 */
export const DEFAULT_BROWSER_COLUMN_WIDTH = 45;
export const MIN_BROWSER_COLUMN_WIDTH = 20;
export const MAX_BROWSER_COLUMN_WIDTH = 80;
export const browserColumnLayoutSchema = z.object({
  width: z.number().finite().min(MIN_BROWSER_COLUMN_WIDTH).max(MAX_BROWSER_COLUMN_WIDTH),
});
export type BrowserColumnLayout = z.infer<typeof browserColumnLayoutSchema>;
