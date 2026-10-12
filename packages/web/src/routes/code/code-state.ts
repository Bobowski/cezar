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

export type CodePanel = 'terminal' | 'services' | 'search'

export interface CodeLayout extends TabsState {
  panel: CodePanel | null
  preview: boolean
}

export const DEFAULT_LAYOUT: CodeLayout = { ...EMPTY_TABS, panel: null, preview: false }

export function loadLayout(storage: Storage | null, projectId: string, tree: string): CodeLayout {
  try {
    const raw = JSON.parse(storage?.getItem(layoutKey(projectId, tree)) ?? 'null') as Partial<CodeLayout> | null
    if (!raw || !Array.isArray(raw.tabs)) return DEFAULT_LAYOUT
    const tabs = raw.tabs
      .filter((tab): tab is CodeTab => typeof tab?.path === 'string' && tab.path !== '')
      .slice(0, 40)
      .map((tab) => ({ path: tab.path, preview: tab.preview === true }))
    const active = typeof raw.active === 'string' && tabs.some((tab) => tab.path === raw.active) ? raw.active : tabs[0]?.path ?? null
    const panel = raw.panel === 'terminal' || raw.panel === 'services' || raw.panel === 'search' ? raw.panel : null
    return { tabs, active, panel, preview: raw.preview === true }
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
