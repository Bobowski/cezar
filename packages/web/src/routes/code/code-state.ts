/**
 * The Code page's state, as plain functions (spec 2026-10-11-code-page §3–4): which tabs are
 * open, what each buffer holds against what is on disk, and what survives a reload. Kept apart
 * from the component so every transition is a unit test.
 */

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

/**
 * The page's shape: one or two editor groups side by side, which sidebar view is open, which
 * panel. `focused` is the group the keyboard and the tree act on.
 */
export interface CodeLayout {
  groups: TabsState[]
  focused: number
  sidebar: CodeSidebar | null
  panel: CodePanel | null
  preview: boolean
  wrap: boolean
}

export const DEFAULT_LAYOUT: CodeLayout = { groups: [EMPTY_TABS], focused: 0, sidebar: 'explorer', panel: null, preview: false, wrap: false }

export const focusedGroup = (layout: CodeLayout): TabsState => layout.groups[layout.focused] ?? layout.groups[0] ?? EMPTY_TABS

/** Every path open in any group, each once. */
export const openPaths = (layout: CodeLayout): string[] => [...new Set(layout.groups.flatMap((group) => group.tabs.map((tab) => tab.path)))]

/** Apply `change` to one group. A second group left without tabs closes; the first never does. */
export function updateGroup(layout: CodeLayout, index: number, change: (group: TabsState) => TabsState): CodeLayout {
  const groups = layout.groups.map((group, at) => (at === index ? change(group) : group))
  const kept = groups.filter((group, at) => at === 0 || group.tabs.length > 0)
  if (kept.length === groups.length) return { ...layout, groups }
  return { ...layout, groups: kept, focused: Math.min(layout.focused, kept.length - 1) }
}

/** Apply `change` to every group — a rename or a delete reaches a file wherever it is open. */
export function updateGroups(layout: CodeLayout, change: (group: TabsState) => TabsState): CodeLayout {
  return layout.groups.reduce((next, _group, index) => updateGroup(next, Math.min(index, next.groups.length - 1), change), layout)
}

/** Open `path` in the group beside the focused one, creating it if there is only one. */
export function openToSide(layout: CodeLayout, path: string): CodeLayout {
  const target = layout.groups.length < 2 ? 1 : layout.focused === 0 ? 1 : 0
  const groups = layout.groups.length < 2 ? [...layout.groups, EMPTY_TABS] : layout.groups
  return updateGroup({ ...layout, groups, focused: target }, target, (group) => openTab(group, path, true))
}

/** The other tabs of `path`'s group, closed. `keep` decides which survive besides `path`. */
export function closeOthers(group: TabsState, path: string, keep: (tab: CodeTab) => boolean = () => false): TabsState {
  return { tabs: group.tabs.filter((tab) => tab.path === path || keep(tab)), active: path }
}

const DIFF_PREFIX = 'diff:'
/** A tab that shows a file's changes instead of the file. Its path is not a path on disk. */
export const diffTab = (path: string): string => `${DIFF_PREFIX}${path}`
export const isDiffTab = (path: string): boolean => path.startsWith(DIFF_PREFIX)
export const tabFile = (path: string): string => (isDiffTab(path) ? path.slice(DIFF_PREFIX.length) : path)
export const tabLabel = (path: string): string => {
  const file = tabFile(path)
  const name = file.slice(file.lastIndexOf('/') + 1)
  return isDiffTab(path) ? `${name} (Working Tree)` : name
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

export function loadLayout(storage: Storage | null, projectId: string, tree: string): CodeLayout {
  try {
    const raw = JSON.parse(storage?.getItem(layoutKey(projectId, tree)) ?? 'null') as (Partial<CodeLayout> & Partial<TabsState>) | null
    if (!raw) return DEFAULT_LAYOUT
    // The first shape this page stored had one group, as `tabs` and `active` at the top level.
    const stored = Array.isArray(raw.groups) ? raw.groups.map(reviveGroup) : [reviveGroup(raw)]
    const groups = stored.filter((group): group is TabsState => group !== null).filter((group, at) => at === 0 || group.tabs.length > 0).slice(0, 2)
    if (groups.length === 0) return DEFAULT_LAYOUT
    const sidebar = raw.sidebar === null ? null : raw.sidebar === 'search' || raw.sidebar === 'scm' ? raw.sidebar : 'explorer'
    return {
      groups,
      focused: typeof raw.focused === 'number' && raw.focused >= 0 && raw.focused < groups.length ? raw.focused : 0,
      sidebar,
      panel: raw.panel === 'terminal' || raw.panel === 'services' ? raw.panel : null,
      preview: raw.preview === true,
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
