/**
 * The Code page's state, as plain functions (spec 2026-10-11-code-page §3–4): which tabs are
 * open, what each buffer holds against what is on disk, and what survives a reload. Kept apart
 * from the component so every transition is a unit test.
 */
import {
  codePageSchema, codePagesTreeSchema, MAX_CODE_PAGE_TREES, MAX_CODE_PAGES, type CodePage, type CodePagesTree,
} from '@open-mercato/cezar-api-client'

import { keepableAddress, pageTitle } from './code-pages'

/** One open file. `preview` is the italic tab a single click reuses until it is kept. */
export interface CodeTab {
  path: string
  preview: boolean
}

export interface TabsState {
  tabs: CodeTab[]
  active: string | null
}

export const EMPTY_TABS: TabsState = { tabs: [], active: null }

/** Open `path`. A single click (`keep: false`) reuses the preview tab; a double click keeps. */
export function openTab(state: TabsState, path: string, keep: boolean): TabsState {
  const existing = state.tabs.find((tab) => tab.path === path)
  if (existing) {
    const tabs = keep && existing.preview ? state.tabs.map((tab) => (tab.path === path ? { ...tab, preview: false } : tab)) : state.tabs
    return { tabs, active: path }
  }
  const tab: CodeTab = { path, preview: !keep }
  const previewAt = keep ? -1 : state.tabs.findIndex((other) => other.preview)
  if (previewAt >= 0) return { tabs: state.tabs.map((other, index) => (index === previewAt ? tab : other)), active: path }
  return { tabs: [...state.tabs, tab], active: path }
}

/** An edit makes a preview tab a kept one. */
export function keepTab(state: TabsState, path: string): TabsState {
  if (!state.tabs.some((tab) => tab.path === path && tab.preview)) return state
  return { ...state, tabs: state.tabs.map((tab) => (tab.path === path ? { ...tab, preview: false } : tab)) }
}

/** Close `path`; the neighbour to the right (else the left) becomes active. */
export function closeTab(state: TabsState, path: string): TabsState {
  const index = state.tabs.findIndex((tab) => tab.path === path)
  if (index === -1) return state
  const tabs = state.tabs.filter((tab) => tab.path !== path)
  const active = state.active === path ? (tabs[index] ?? tabs[index - 1])?.path ?? null : state.active
  return { tabs, active }
}

/** The tab `step` away from the active one, wrapping. */
export function stepTab(state: TabsState, step: 1 | -1): TabsState {
  if (state.tabs.length < 2 || state.active === null) return state
  const index = state.tabs.findIndex((tab) => tab.path === state.active)
  const next = state.tabs[(index + step + state.tabs.length) % state.tabs.length]
  return next ? { ...state, active: next.path } : state
}

/** A rename or a delete seen from the tab strip. `to: null` closes the tab. */
export function retargetTab(state: TabsState, from: string, to: string | null): TabsState {
  if (to === null) return closeTab(state, from)
  return {
    tabs: state.tabs.map((tab) => (tab.path === from ? { ...tab, path: to } : tab)),
    active: state.active === from ? to : state.active,
  }
}

/** What the page knows about one file. `draft === null` is a clean buffer. */
export interface Buffer {
  /** What is on disk as last read or saved, and the token it was read with. */
  content: string
  hash: string
  draft: string | null
  /** The file changed on disk under unsaved edits, or a save was refused: `diskHash` is disk's. */
  conflict: { diskHash: string; diskContent: string } | null
}

export const isDirty = (buffer: Buffer | undefined): boolean => buffer !== undefined && buffer.draft !== null && buffer.draft !== buffer.content

/**
 * Disk answered for an open file. A clean buffer follows it; a dirty one keeps its edits and is
 * told (spec §4: "a clean tab reloads itself, a dirty tab gets the banner").
 */
export function reconcile(buffer: Buffer, disk: { content: string; hash: string }): Buffer {
  if (disk.hash === buffer.hash) return buffer.conflict ? { ...buffer, conflict: null } : buffer
  if (!isDirty(buffer)) return { content: disk.content, hash: disk.hash, draft: null, conflict: null }
  return { ...buffer, conflict: { diskHash: disk.hash, diskContent: disk.content } }
}

/** The banner's two writing exits (Compare only looks). */
export function resolveConflict(buffer: Buffer, choice: 'reload' | 'overwrite'): Buffer {
  if (!buffer.conflict) return buffer
  const { diskHash, diskContent } = buffer.conflict
  // Overwrite adopts disk's token so the next save is against what the user has now seen.
  return choice === 'reload'
    ? { content: diskContent, hash: diskHash, draft: null, conflict: null }
    : { content: diskContent, hash: diskHash, draft: buffer.draft, conflict: null }
}

// ---- what survives a reload --------------------------------------------------------------------

export interface Storage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

const layoutKey = (projectId: string, tree: string) => `cez:code:layout:${projectId}:${tree}`
const draftKey = (projectId: string, tree: string, path: string) => `cez:code:draft:${projectId}:${tree}:${path}`

export type CodePanel = 'terminal' | 'services'
export type CodeSidebar = 'explorer' | 'search' | 'scm'

/** A Browser tab: ONE page (spec 2026-10-24-code-page-browser-tabs §2). `url` is the address it
 *  last loaded; `''` is a blank tab. */
export interface CodeBrowser {
  url: string
}

/** As many groups as fit a screen; past this a split opens in the neighbour instead. */
export const MAX_GROUPS = 4
/** No group is dragged narrower than this share of the row, in percent (the panel's `minSize`). */
export const MIN_GROUP_SIZE = 12

/**
 * The page's shape: editor groups side by side with their widths, which sidebar view is open,
 * the bottom panel and the agent pane with their sizes. `focused` is the group the keyboard and
 * the explorer act on.
 */
export interface CodeLayout {
  groups: TabsState[]
  /** Each group's share of the row, in percent; always sums to 100. */
  sizes: number[]
  focused: number
  sidebar: CodeSidebar
  panel: CodePanel | null
  /** The bottom panel's share of the column, in percent. */
  panelSize: number
  /** State of every open browser tab, by the id in its tab path. */
  browsers: Record<string, CodeBrowser>
  /** The task every open agent tab shows, by the id in its tab path; `null` is the new-task form. */
  agents: Record<string, string | null>
  wrap: boolean
}

export const DEFAULT_LAYOUT: CodeLayout = {
  groups: [EMPTY_TABS], sizes: [100], focused: 0, sidebar: 'explorer', panel: null, panelSize: 32,
  browsers: {}, agents: {}, wrap: false,
}

export const focusedGroup = (layout: CodeLayout): TabsState => layout.groups[layout.focused] ?? layout.groups[0] ?? EMPTY_TABS

/** Every path open in any group, each once. */
export const openPaths = (layout: CodeLayout): string[] => [...new Set(layout.groups.flatMap((group) => group.tabs.map((tab) => tab.path)))]

const equalSizes = (count: number): number[] => Array.from({ length: count }, () => 100 / count)

/** Apply `change` to one group. A group left without tabs closes — unless it is the only one. */
export function updateGroup(layout: CodeLayout, index: number, change: (group: TabsState) => TabsState): CodeLayout {
  const groups = layout.groups.map((group, at) => (at === index ? change(group) : group))
  const emptied = groups.findIndex((group, at) => at === index && group.tabs.length === 0)
  if (emptied === -1 || groups.length === 1) return { ...layout, groups }
  // The closed group's width goes to its left neighbour (the right one for the first group).
  const heir = emptied === 0 ? 1 : emptied - 1
  const sizes = layout.sizes.map((size, at) => (at === heir ? size + (layout.sizes[emptied] ?? 0) : size)).filter((_size, at) => at !== emptied)
  const focused = layout.focused > emptied ? layout.focused - 1 : Math.min(layout.focused, groups.length - 2)
  return { ...layout, groups: groups.filter((_group, at) => at !== emptied), sizes, focused }
}

/** Apply `change` to every group — a rename or a delete reaches a file wherever it is open. */
export function updateGroups(layout: CodeLayout, change: (group: TabsState) => TabsState): CodeLayout {
  let next = layout
  // Right to left, so a group that closes does not shift the ones still to visit.
  for (let index = layout.groups.length - 1; index >= 0; index -= 1) next = updateGroup(next, index, change)
  return next
}

/**
 * Open `path` beside the focused group: in a NEW group to its right while there is room for
 * one, else in the group already there. The new group takes half of the focused one's width.
 */
export function openToSide(layout: CodeLayout, path: string): CodeLayout {
  const from = Math.min(layout.focused, layout.groups.length - 1)
  if (layout.groups.length >= MAX_GROUPS) {
    const target = from === layout.groups.length - 1 ? from - 1 : from + 1
    return updateGroup({ ...layout, focused: target }, target, (group) => openTab(group, path, true))
  }
  const half = (layout.sizes[from] ?? 100) / 2
  const groups = [...layout.groups.slice(0, from + 1), openTab(EMPTY_TABS, path, true), ...layout.groups.slice(from + 1)]
  const sizes = [...layout.sizes.slice(0, from), half, half, ...layout.sizes.slice(from + 1)]
  return { ...layout, groups, sizes, focused: from + 1 }
}

export const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value))

/** The other tabs of `path`'s group, closed. `keep` decides which survive besides `path`. */
export function closeOthers(group: TabsState, path: string, keep: (tab: CodeTab) => boolean = () => false): TabsState {
  return { tabs: group.tabs.filter((tab) => tab.path === path || keep(tab)), active: path }
}

const DIFF_PREFIX = 'diff:'
const BROWSER_PREFIX = 'browser:'
const AGENT_PREFIX = 'agent:'
/** A tab that shows a file's changes instead of the file. Its path is not a path on disk. */
export const diffTab = (path: string): string => `${DIFF_PREFIX}${path}`
export const isDiffTab = (path: string): boolean => path.startsWith(DIFF_PREFIX)
/** A tab that is a browser: the app the project serves, beside its code. */
export const browserTab = (id: string): string => `${BROWSER_PREFIX}${id}`
export const isBrowserTab = (path: string): boolean => path.startsWith(BROWSER_PREFIX)
export const browserId = (path: string): string => path.slice(BROWSER_PREFIX.length)
/** A tab that is an agent: a task's conversation, or the form that starts one. */
export const agentTab = (id: string): string => `${AGENT_PREFIX}${id}`
export const isAgentTab = (path: string): boolean => path.startsWith(AGENT_PREFIX)
export const agentId = (path: string): string => path.slice(AGENT_PREFIX.length)
/** A tab with no file behind it: a browser or an agent. */
export const isToolTab = (path: string): boolean => isBrowserTab(path) || isAgentTab(path)
/** A tab that IS a file in the editor — the only kind with a buffer, a path and a draft. */
export const isFileTab = (path: string): boolean => !isDiffTab(path) && !isToolTab(path)
export const tabFile = (path: string): string => (isDiffTab(path) ? path.slice(DIFF_PREFIX.length) : path)
/**
 * `agentTitles` names the task each agent tab shows, by tab id; absent is the new-task form.
 * `gateways` is the preview-gateway origin each Browser tab is framed through on a hosted cockpit.
 */
export const tabLabel = (
  path: string, browsers: Record<string, CodeBrowser> = {}, agentTitles: Record<string, string> = {}, gateways: Record<string, string> = {},
): string => {
  if (isAgentTab(path)) return agentTitles[agentId(path)] ?? 'New task'
  if (isBrowserTab(path)) return pageTitle(browsers[browserId(path)]?.url ?? '', gateways[browserId(path)])
  const file = tabFile(path)
  const name = file.slice(file.lastIndexOf('/') + 1)
  return isDiffTab(path) ? `${name} (Working Tree)` : name
}

/** A fresh id for a tool tab (`browser:<id>`, `agent:<id>`). */
export const newTabId = (): string => Math.random().toString(36).slice(2, 10) || 'tab'

/**
 * Open a Browser tab at `url` (`''`: blank) — the ONE way the Code page opens a page: Ctrl/Cmd+T,
 * the palette, and the terminal's links and strips (spec 2026-10-24-code-page-terminal §3.1–3.2).
 * `beside` puts it in a new group to the right of the focused one, as `openToSide` does a file.
 * The address is NOT checked here: callers pass what `appAddress` (code-pages.ts) accepted.
 */
export function openBrowserTab(layout: CodeLayout, url: string, options: { beside?: boolean; id?: string } = {}): CodeLayout {
  const id = options.id ?? newTabId()
  const next = { ...layout, browsers: { ...layout.browsers, [id]: { url } } }
  return options.beside ? openToSide(next, browserTab(id)) : updateGroup(next, next.focused, (group) => openTab(group, browserTab(id), true))
}

/** Every Browser tab, left to right and in tab order, with the group it sits in. */
export function browserTabs(layout: CodeLayout): Array<{ id: string; url: string; group: number }> {
  return layout.groups.flatMap((group, at) => group.tabs.filter((tab) => isBrowserTab(tab.path)).map((tab) => {
    const id = browserId(tab.path)
    return { id, url: layout.browsers[id]?.url ?? '', group: at }
  }))
}

/** Show the Browser tab `id` (its group gains focus). */
export function focusBrowserTab(layout: CodeLayout, id: string): CodeLayout {
  const at = layout.groups.findIndex((group) => group.tabs.some((tab) => tab.path === browserTab(id)))
  return at === -1 ? layout : updateGroup({ ...layout, focused: at }, at, (group) => ({ ...group, active: browserTab(id) }))
}

// ---- the server's copy of the pages (spec 2026-10-24-code-page-browser-tabs §3 Persistence) -----

/** What the server keeps for this layout: each page with an address worth keeping, in order. */
export function pagesOf(layout: CodeLayout): CodePage[] {
  const pages: CodePage[] = []
  for (const tab of browserTabs(layout)) {
    if (pages.length >= MAX_CODE_PAGES || !keepableAddress(tab.url) || !/^[a-z0-9]{1,16}$/.test(tab.id)) continue
    pages.push({ id: tab.id, url: tab.url, group: Math.min(tab.group, MAX_GROUPS - 1) })
  }
  return pages
}

/** This checkout's saved pages, salvaged entry by entry (a hand-edited file must not cost the rest);
 *  `undefined` when this checkout was never saved. */
export function savedPagesFor(raw: unknown, tree: string): CodePage[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const entry = (raw as unknown[]).find((each): each is { tree: string; pages: unknown } => (each as { tree?: unknown } | null)?.tree === tree)
  if (!entry || !Array.isArray(entry.pages)) return undefined
  return entry.pages.flatMap((page: unknown) => {
    const parsed = codePageSchema.safeParse(page)
    return parsed.success ? [parsed.data] : []
  })
}

/** The whole `codePages` value with this checkout's pages first — the PUT is a shallow merge. */
export function withPages(raw: unknown, tree: string, pages: CodePage[]): CodePagesTree[] {
  const others = (Array.isArray(raw) ? raw as unknown[] : []).flatMap((each) => {
    const parsed = codePagesTreeSchema.safeParse(each)
    return parsed.success && parsed.data.tree !== tree ? [parsed.data] : []
  })
  return [{ tree, pages: pages.slice(0, MAX_CODE_PAGES) }, ...others].slice(0, MAX_CODE_PAGE_TREES)
}

/**
 * Fold the server's pages into the layout this browser remembered. The server is the newer word
 * (another device may have opened, moved or closed pages): a tab it knows takes its address, a
 * tab with an address it does not know was closed elsewhere and closes, and a page only it knows
 * opens in its group — a new group to the right when this layout has fewer. A blank tab is never
 * on the server and stays. `saved === undefined` (never saved) leaves the layout alone.
 */
export function restorePages(layout: CodeLayout, saved: readonly CodePage[] | undefined): CodeLayout {
  if (saved === undefined) return layout
  const byId = new Map(saved.map((page) => [page.id, page]))
  let next: CodeLayout = { ...layout, browsers: { ...layout.browsers } }
  for (const tab of browserTabs(layout)) {
    const page = byId.get(tab.id)
    if (page) next.browsers[tab.id] = { url: page.url }
    else if (tab.url !== '') next = updateGroups(next, (group) => closeTab(group, browserTab(tab.id)))
  }
  const open = new Set(browserTabs(next).map((tab) => tab.id))
  for (const page of saved) {
    if (open.has(page.id)) continue
    const browsers = { ...next.browsers, [page.id]: { url: page.url } }
    next = page.group < next.groups.length
      ? updateGroup({ ...next, browsers }, page.group, (group) => openTab(group, browserTab(page.id), true))
      : openToSide({ ...next, browsers, focused: next.groups.length - 1 }, browserTab(page.id))
  }
  return pruneTools({ ...next, focused: Math.min(layout.focused, next.groups.length - 1) })
}

/**
 * An agent tab for `runId` (`null`: the new-task form). One that already shows that task is
 * focused instead of opened twice; `side` puts a new one beside the focused group.
 */
export function openAgent(layout: CodeLayout, id: string, runId: string | null, side = false): CodeLayout {
  const existing = runId === null ? undefined : Object.entries(layout.agents).find(([, shown]) => shown === runId)?.[0]
  if (existing !== undefined) {
    const at = layout.groups.findIndex((group) => group.tabs.some((tab) => tab.path === agentTab(existing)))
    if (at !== -1) return updateGroup({ ...layout, focused: at }, at, (group) => ({ ...group, active: agentTab(existing) }))
  }
  const next = { ...layout, agents: { ...layout.agents, [id]: runId } }
  return side ? openToSide(next, agentTab(id)) : updateGroup(next, next.focused, (group) => openTab(group, agentTab(id), true))
}

/** Forget the state of browser and agent tabs no group shows any more. */
export function pruneTools(layout: CodeLayout): CodeLayout {
  const open = openPaths(layout)
  const browserIds = new Set(open.filter(isBrowserTab).map(browserId))
  const agentIds = new Set(open.filter(isAgentTab).map(agentId))
  const browsers = Object.fromEntries(Object.entries(layout.browsers).filter(([id]) => browserIds.has(id)))
  const agents = Object.fromEntries(Object.entries(layout.agents).filter(([id]) => agentIds.has(id)))
  const same = Object.keys(browsers).length === Object.keys(layout.browsers).length && Object.keys(agents).length === Object.keys(layout.agents).length
  return same ? layout : { ...layout, browsers, agents }
}

function reviveGroup(raw: unknown): TabsState | null {
  const value = raw as Partial<TabsState> | null
  if (!value || !Array.isArray(value.tabs)) return null
  const tabs = value.tabs
    .filter((tab): tab is CodeTab => typeof tab?.path === 'string' && tab.path !== '')
    .slice(0, 40)
    .map((tab) => ({ path: tab.path, preview: tab.preview === true }))
  const active = typeof value.active === 'string' && tabs.some((tab) => tab.path === value.active) ? value.active : tabs[0]?.path ?? null
  return { tabs, active }
}

/** `{ url }`, or the first shape (`{ tabs, active }`, a browser with tabs of its own). Only a
 *  loopback address comes back (§5): anything else returns as a blank tab. */
function reviveBrowsers(raw: unknown, open: ReadonlySet<string>): Record<string, CodeBrowser> {
  const out: Record<string, CodeBrowser> = {}
  if (!raw || typeof raw !== 'object') return out
  for (const [id, value] of Object.entries(raw as Record<string, { url?: unknown; tabs?: unknown; active?: unknown } | null>)) {
    if (!open.has(id) || !value) continue
    const legacy = Array.isArray(value.tabs) ? value.tabs[typeof value.active === 'number' ? value.active : 0] ?? value.tabs[0] : undefined
    const url = typeof value.url === 'string' ? value.url : typeof legacy === 'string' ? legacy : ''
    out[id] = { url: keepableAddress(url) ? url : '' }
  }
  return out
}

const number = (raw: unknown, fallback: number, min: number, max: number): number =>
  typeof raw === 'number' && Number.isFinite(raw) ? clamp(raw, min, max) : fallback

export function loadLayout(storage: Storage | null, projectId: string, tree: string): CodeLayout {
  try {
    const raw = JSON.parse(storage?.getItem(layoutKey(projectId, tree)) ?? 'null') as (Partial<CodeLayout> & Partial<TabsState>) | null
    if (!raw) return DEFAULT_LAYOUT
    // The first shape this page stored had one group, as `tabs` and `active` at the top level.
    const stored = Array.isArray(raw.groups) ? raw.groups.map(reviveGroup) : [reviveGroup(raw)]
    const groups = stored.filter((group): group is TabsState => group !== null).filter((group, at) => at === 0 || group.tabs.length > 0).slice(0, MAX_GROUPS)
    if (groups.length === 0) return DEFAULT_LAYOUT
    const sizes = Array.isArray(raw.sizes) && raw.sizes.length === groups.length && raw.sizes.every((size) => typeof size === 'number' && size >= 1)
      && Math.abs(raw.sizes.reduce((sum, size) => sum + size, 0) - 100) < 0.5
      ? raw.sizes
      : equalSizes(groups.length)
    const paths = groups.flatMap((group) => group.tabs.map((tab) => tab.path))
    const open = new Set(paths.filter(isBrowserTab).map(browserId))
    const agents: Record<string, string | null> = {}
    for (const id of paths.filter(isAgentTab).map(agentId)) {
      const shown = (raw.agents as Record<string, unknown> | undefined)?.[id]
      agents[id] = typeof shown === 'string' && shown !== '' ? shown : null
    }
    return {
      groups,
      sizes,
      focused: typeof raw.focused === 'number' && raw.focused >= 0 && raw.focused < groups.length ? raw.focused : 0,
      sidebar: raw.sidebar === 'search' || raw.sidebar === 'scm' ? raw.sidebar : 'explorer',
      panel: raw.panel === 'terminal' || raw.panel === 'services' ? raw.panel : null,
      panelSize: number(raw.panelSize, DEFAULT_LAYOUT.panelSize, 10, 80),
      browsers: reviveBrowsers(raw.browsers, open),
      agents,
      wrap: raw.wrap === true,
    }
  } catch {
    return DEFAULT_LAYOUT
  }
}

export function saveLayout(storage: Storage | null, projectId: string, tree: string, layout: CodeLayout): void {
  try {
    storage?.setItem(layoutKey(projectId, tree), JSON.stringify(layout))
  } catch {
    // A full or forbidden storage costs the layout, never the page.
  }
}

/** Unsaved typing, keyed by the token it was typed against — a draft for another version of the
 *  file is not silently applied over this one. */
export function loadDraft(storage: Storage | null, projectId: string, tree: string, path: string): { baseHash: string; content: string } | null {
  try {
    const raw = JSON.parse(storage?.getItem(draftKey(projectId, tree, path)) ?? 'null') as { baseHash?: unknown; content?: unknown } | null
    return raw && typeof raw.baseHash === 'string' && typeof raw.content === 'string' ? { baseHash: raw.baseHash, content: raw.content } : null
  } catch {
    return null
  }
}

export function saveDraft(storage: Storage | null, projectId: string, tree: string, path: string, buffer: Buffer | undefined): void {
  try {
    if (buffer && isDirty(buffer)) storage?.setItem(draftKey(projectId, tree, path), JSON.stringify({ baseHash: buffer.hash, content: buffer.draft }))
    else storage?.removeItem(draftKey(projectId, tree, path))
  } catch {
    // As above.
  }
}

/** A file just read, with whatever was typed into it before the reload. */
export function bufferFrom(disk: { content: string; hash: string }, draft: { baseHash: string; content: string } | null): Buffer {
  const clean: Buffer = { content: disk.content, hash: disk.hash, draft: null, conflict: null }
  if (!draft || draft.content === disk.content) return clean
  if (draft.baseHash === disk.hash) return { ...clean, draft: draft.content }
  // Typed against an older version: keep the typing, and say the file moved on.
  return { content: disk.content, hash: draft.baseHash, draft: draft.content, conflict: { diskHash: disk.hash, diskContent: disk.content } }
}

// ---- what a file's diff says about its lines ---------------------------------------------------

/**
 * Which lines of the working copy differ from the committed version, from the file's unified
 * diff: an added run is `add`, an added run that replaces deleted lines is `mod`, and lines
 * removed with nothing in their place leave a `del` tick on the line that now follows them.
 */
export function lineMarksFromPatch(patch: string): Map<number, 'add' | 'mod' | 'del'> {
  const marks = new Map<number, 'add' | 'mod' | 'del'>()
  let next = 0
  let deleted = 0
  let run: number[] = []
  const flush = () => {
    if (run.length > 0) for (const line of run) marks.set(line, deleted > 0 ? 'mod' : 'add')
    else if (deleted > 0 && next > 0 && !marks.has(next)) marks.set(next, 'del')
    deleted = 0
    run = []
  }
  for (const line of patch.split('\n')) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
    if (hunk) {
      flush()
      next = Number(hunk[1])
      continue
    }
    if (next === 0 || line.startsWith('\\')) continue
    if (line.startsWith('+')) {
      run.push(next)
      next += 1
    } else if (line.startsWith('-')) {
      deleted += 1
    } else {
      flush()
      next += 1
    }
  }
  flush()
  return marks
}

const LANGUAGES: Record<string, string> = {
  ts: 'TypeScript', tsx: 'TypeScript JSX', js: 'JavaScript', jsx: 'JavaScript JSX', mjs: 'JavaScript', cjs: 'JavaScript', json: 'JSON',
  md: 'Markdown', mdx: 'MDX', css: 'CSS', scss: 'SCSS', html: 'HTML', yml: 'YAML', yaml: 'YAML', toml: 'TOML', py: 'Python', rb: 'Ruby',
  go: 'Go', rs: 'Rust', java: 'Java', kt: 'Kotlin', swift: 'Swift', php: 'PHP', sh: 'Shell Script', sql: 'SQL', xml: 'XML', svg: 'SVG',
  c: 'C', h: 'C', cpp: 'C++', cs: 'C#', vue: 'Vue', svelte: 'Svelte', graphql: 'GraphQL', prisma: 'Prisma', dockerfile: 'Dockerfile',
}
/** The status bar's language name: by extension, by a few well-known names, else plain text. */
export function languageOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase()
  if (name === 'dockerfile' || name === 'makefile') return name === 'dockerfile' ? 'Dockerfile' : 'Makefile'
  if (name.startsWith('.env')) return 'Environment'
  return LANGUAGES[name.slice(name.lastIndexOf('.') + 1)] ?? 'Plain Text'
}
