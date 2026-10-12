import { describe, expect, it } from 'vitest'

import {
  bufferFrom, closeTab, DEFAULT_LAYOUT, EMPTY_TABS, isDirty, keepTab, loadDraft, loadLayout, openTab, reconcile, resolveConflict,
  retargetTab, saveDraft, saveLayout, stepTab, type Buffer, type Storage,
} from './code-state'

const memory = (): Storage & { map: Map<string, string> } => {
  const map = new Map<string, string>()
  return { map, getItem: (key) => map.get(key) ?? null, setItem: (key, value) => void map.set(key, value), removeItem: (key) => void map.delete(key) }
}
const clean = (content: string, hash: string): Buffer => ({ content, hash, draft: null, conflict: null })

describe('Code page tabs (spec 2026-10-11-code-page §3)', () => {
  it('a single click reuses the preview tab; a double click or an edit keeps it', () => {
    let state = openTab(EMPTY_TABS, 'a.ts', false)
    state = openTab(state, 'b.ts', false)
    expect(state).toEqual({ tabs: [{ path: 'b.ts', preview: true }], active: 'b.ts' })
    state = keepTab(state, 'b.ts')
    state = openTab(state, 'c.ts', false)
    expect(state.tabs).toEqual([{ path: 'b.ts', preview: false }, { path: 'c.ts', preview: true }])
    state = openTab(state, 'c.ts', true)
    expect(state.tabs[1]).toEqual({ path: 'c.ts', preview: false })
    // Opening what is open only activates it.
    expect(openTab(state, 'b.ts', false)).toEqual({ ...state, active: 'b.ts' })
  })

  it('closing activates the neighbour, stepping wraps, and a rename follows the file', () => {
    const state = { tabs: ['a', 'b', 'c'].map((path) => ({ path, preview: false })), active: 'b' }
    expect(closeTab(state, 'b').active).toBe('c')
    expect(closeTab({ ...state, active: 'c' }, 'c').active).toBe('b')
    expect(closeTab(state, 'a').active).toBe('b')
    expect(closeTab({ tabs: [{ path: 'a', preview: false }], active: 'a' }, 'a')).toEqual(EMPTY_TABS)
    expect(stepTab({ ...state, active: 'c' }, 1).active).toBe('a')
    expect(stepTab({ ...state, active: 'a' }, -1).active).toBe('c')
    expect(retargetTab(state, 'b', 'd')).toEqual({ tabs: [{ path: 'a', preview: false }, { path: 'd', preview: false }, { path: 'c', preview: false }], active: 'd' })
    expect(retargetTab(state, 'b', null).tabs.map((tab) => tab.path)).toEqual(['a', 'c'])
  })
})

describe('a buffer against the other writer (spec §4)', () => {
  it('a clean buffer follows disk; a dirty one keeps its edits and is told', () => {
    expect(reconcile(clean('one', 'h1'), { content: 'two', hash: 'h2' })).toEqual(clean('two', 'h2'))
    const dirty: Buffer = { ...clean('one', 'h1'), draft: 'mine' }
    const told = reconcile(dirty, { content: 'two', hash: 'h2' })
    expect(told).toEqual({ ...dirty, conflict: { diskHash: 'h2', diskContent: 'two' } })
    expect(isDirty(told)).toBe(true)
    // Disk went back to what the buffer was read from: nothing to resolve any more.
    expect(reconcile(told, { content: 'one', hash: 'h1' }).conflict).toBeNull()
    expect(reconcile(dirty, { content: 'one', hash: 'h1' })).toBe(dirty)
  })

  it('reload drops the edits; overwrite keeps them against the version now seen', () => {
    const conflicted: Buffer = { content: 'one', hash: 'h1', draft: 'mine', conflict: { diskHash: 'h2', diskContent: 'two' } }
    expect(resolveConflict(conflicted, 'reload')).toEqual(clean('two', 'h2'))
    expect(resolveConflict(conflicted, 'overwrite')).toEqual({ content: 'two', hash: 'h2', draft: 'mine', conflict: null })
  })

  it('a draft equal to the saved text is not dirty', () => {
    expect(isDirty({ ...clean('one', 'h1'), draft: 'one' })).toBe(false)
    expect(isDirty(undefined)).toBe(false)
  })
})

describe('what survives a reload', () => {
  it('restores tabs, the active one and the panel — and survives garbage', () => {
    const storage = memory()
    expect(loadLayout(storage, 'p', 'main')).toEqual(DEFAULT_LAYOUT)
    saveLayout(storage, 'p', 'main', { tabs: [{ path: 'a.ts', preview: false }], active: 'a.ts', panel: 'search', preview: true })
    expect(loadLayout(storage, 'p', 'main')).toEqual({ tabs: [{ path: 'a.ts', preview: false }], active: 'a.ts', panel: 'search', preview: true })
    // Another checkout of the same project has its own layout.
    expect(loadLayout(storage, 'p', 'run-1')).toEqual(DEFAULT_LAYOUT)
    storage.setItem('cez:code:layout:p:main', '{"tabs":[{"path":7},{"path":"b.ts"}],"active":"gone","panel":"nope"}')
    expect(loadLayout(storage, 'p', 'main')).toEqual({ tabs: [{ path: 'b.ts', preview: false }], active: 'b.ts', panel: null, preview: false })
    storage.setItem('cez:code:layout:p:main', '{ not json')
    expect(loadLayout(storage, 'p', 'main')).toEqual(DEFAULT_LAYOUT)
    expect(loadLayout(null, 'p', 'main')).toEqual(DEFAULT_LAYOUT)
  })

  it('keeps typing across a reload, and flags a draft typed against an older version', () => {
    const storage = memory()
    saveDraft(storage, 'p', 'main', 'a.ts', { ...clean('one', 'h1'), draft: 'mine' })
    const draft = loadDraft(storage, 'p', 'main', 'a.ts')
    expect(draft).toEqual({ baseHash: 'h1', content: 'mine' })
    expect(bufferFrom({ content: 'one', hash: 'h1' }, draft)).toEqual({ ...clean('one', 'h1'), draft: 'mine' })
    expect(bufferFrom({ content: 'two', hash: 'h2' }, draft)).toEqual({ content: 'two', hash: 'h1', draft: 'mine', conflict: { diskHash: 'h2', diskContent: 'two' } })
    expect(bufferFrom({ content: 'mine', hash: 'h3' }, draft)).toEqual(clean('mine', 'h3'))
    // A saved buffer leaves no draft behind.
    saveDraft(storage, 'p', 'main', 'a.ts', clean('mine', 'h3'))
    expect(storage.map.size).toBe(0)
  })
})
