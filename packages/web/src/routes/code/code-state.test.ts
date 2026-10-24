import { describe, expect, it } from 'vitest'

import {
  agentTab, browserTab, bufferFrom, closeOthers, closeTab, DEFAULT_LAYOUT, diffTab, EMPTY_TABS, focusedGroup, isDiffTab, isDirty, isFileTab, keepTab,
  languageOf, lineMarksFromPatch, loadDraft, loadLayout, MAX_GROUPS, openAgent, openBrowserTab, openPaths, openTab, openToSide,
  browserTabs, focusBrowserTab, pagesOf, pruneTools, reconcile, resolveConflict, restorePages, retargetTab, saveDraft, saveLayout,
  savedPagesFor, stepTab, tabFile, tabLabel, updateGroup, updateGroups, withPages, type Buffer, type CodeLayout, type Storage,
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
  it('restores groups with their widths, the panes and browser tabs — and survives garbage', () => {
    const storage = memory()
    expect(loadLayout(storage, 'p', 'main')).toEqual(DEFAULT_LAYOUT)
    const layout: CodeLayout = {
      groups: [{ tabs: [{ path: 'a.ts', preview: false }], active: 'a.ts' }, { tabs: [{ path: 'browser:b1', preview: false }], active: 'browser:b1' }],
      sizes: [70, 30], focused: 1, sidebar: 'scm', panel: 'terminal', panelSize: 40,
      browsers: { b1: { url: 'http://localhost:3000/' } }, agents: {}, wrap: true,
    }
    saveLayout(storage, 'p', 'main', layout)
    expect(loadLayout(storage, 'p', 'main')).toEqual(layout)
    // Another checkout of the same project has its own layout.
    expect(loadLayout(storage, 'p', 'run-1')).toEqual(DEFAULT_LAYOUT)
    storage.setItem('cez:code:layout:p:main', JSON.stringify({
      groups: [{ tabs: [{ path: 7 }, { path: 'b.ts' }], active: 'gone' }, { tabs: [] }], sizes: [10, 20], focused: 5, panel: 'nope', sidebar: null,
      panelSize: 2, browsers: { orphan: { tabs: ['x'], active: 0 } }, agents: { orphan: 'run-1' },
    }))
    expect(loadLayout(storage, 'p', 'main')).toEqual({ ...DEFAULT_LAYOUT, groups: [{ tabs: [{ path: 'b.ts', preview: false }], active: 'b.ts' }], panelSize: 10 })
    storage.setItem('cez:code:layout:p:main', '{ not json')
    expect(loadLayout(storage, 'p', 'main')).toEqual(DEFAULT_LAYOUT)
    expect(loadLayout(null, 'p', 'main')).toEqual(DEFAULT_LAYOUT)
  })

  it('reads the single-group layout this page first stored', () => {
    const storage = memory()
    storage.setItem('cez:code:layout:p:main', '{"tabs":[{"path":"a.ts","preview":false}],"active":"a.ts","panel":"search","preview":false}')
    expect(loadLayout(storage, 'p', 'main')).toMatchObject({ groups: [{ tabs: [{ path: 'a.ts', preview: false }], active: 'a.ts' }], sizes: [100], focused: 0, sidebar: 'explorer', panel: null })
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

describe('editor groups', () => {
  const one = (...paths: string[]): CodeLayout => ({ ...DEFAULT_LAYOUT, groups: [{ tabs: paths.map((path) => ({ path, preview: false })), active: paths[0] ?? null }] })
  const shape = (layout: CodeLayout) => layout.groups.map((group) => group.tabs.map((tab) => tab.path))

  it('splits to the right of the focused group, halving its width, up to the cap', () => {
    let layout = openToSide(one('a.ts'), 'a.ts')
    expect(shape(layout)).toEqual([['a.ts'], ['a.ts']])
    expect(layout.sizes).toEqual([50, 50])
    expect(layout.focused).toBe(1)
    expect(focusedGroup(layout).active).toBe('a.ts')
    // From the FIRST group: the new one lands between the two.
    layout = openToSide({ ...layout, focused: 0 }, 'b.ts')
    expect(shape(layout)).toEqual([['a.ts'], ['b.ts'], ['a.ts']])
    expect(layout.sizes).toEqual([25, 25, 50])
    layout = openToSide(layout, 'c.ts')
    expect(layout.groups).toHaveLength(MAX_GROUPS)
    // At the cap a split opens in the neighbour instead of a fifth group.
    const full = openToSide(layout, 'd.ts')
    expect(full.groups).toHaveLength(MAX_GROUPS)
    expect(openPaths(full)).toContain('d.ts')
  })

  it('a group left empty closes and hands its width to a neighbour; the last one stays', () => {
    const split = { ...openToSide(openToSide(one('a.ts'), 'b.ts'), 'c.ts'), sizes: [50, 30, 20] }
    const closed = updateGroup(split, 1, (group) => closeTab(group, 'b.ts'))
    expect(shape(closed)).toEqual([['a.ts'], ['c.ts']])
    expect(closed.sizes).toEqual([80, 20])
    expect(closed.focused).toBe(1)
    const first = updateGroup(split, 0, (group) => closeTab(group, 'a.ts'))
    expect(first.sizes).toEqual([80, 20])
    expect(updateGroup(one('a.ts'), 0, (group) => closeTab(group, 'a.ts')).groups).toEqual([EMPTY_TABS])
  })

  it('a rename or a delete reaches the file in every group', () => {
    const split = openToSide(one('a.ts', 'c.ts'), 'a.ts')
    expect(shape(updateGroups(split, (group) => retargetTab(group, 'a.ts', 'z.ts')))).toEqual([['z.ts', 'c.ts'], ['z.ts']])
    // Deleting the only tab of the second group closes that group.
    expect(shape(updateGroups(split, (group) => retargetTab(group, 'a.ts', null)))).toEqual([['c.ts']])
  })

  it('closes the other tabs, keeping the ones asked for', () => {
    const group = one('a', 'b', 'c').groups[0]!
    expect(closeOthers(group, 'b').tabs.map((tab) => tab.path)).toEqual(['b'])
    expect(closeOthers(group, 'b', (tab) => tab.path === 'c')).toEqual({ tabs: [{ path: 'b', preview: false }, { path: 'c', preview: false }], active: 'b' })
  })

  it('names a diff tab after its file and a browser tab after its address', () => {
    expect(isDiffTab(diffTab('src/app.ts'))).toBe(true)
    expect(tabFile(diffTab('src/app.ts'))).toBe('src/app.ts')
    expect(tabLabel(diffTab('src/app.ts'))).toBe('app.ts (Working Tree)')
    expect(tabLabel('src/app.ts')).toBe('app.ts')
    expect(isFileTab('src/app.ts')).toBe(true)
    expect(isFileTab(diffTab('src/app.ts')) || isFileTab(browserTab('b1'))).toBe(false)
    expect(tabLabel(browserTab('b1'), { b1: { url: 'http://localhost:3000/eu' } })).toBe('localhost:3000/eu')
    expect(tabLabel(browserTab('b1'), { b1: { url: '' } })).toBe('Browser')
  })

  it('opens a browser as a tab of the focused group and forgets its state when it closes', () => {
    const opened = openBrowserTab(one('a.ts'), 'http://localhost:3000/', { id: 'b1' })
    expect(shape(opened)).toEqual([['a.ts', 'browser:b1']])
    expect(opened.groups[0]?.active).toBe('browser:b1')
    expect(opened.browsers).toEqual({ b1: { url: 'http://localhost:3000/' } })
    expect(pruneTools(opened)).toBe(opened)
    expect(pruneTools(updateGroup(opened, 0, (group) => closeTab(group, 'browser:b1'))).browsers).toEqual({})
  })

  it('opens an agent as a tab, focuses the one already showing a task, and forgets a closed one', () => {
    const fresh = openAgent(one('a.ts'), 'g1', null)
    expect(shape(fresh)).toEqual([['a.ts', 'agent:g1']])
    expect(fresh.agents).toEqual({ g1: null })
    expect(tabLabel(agentTab('g1'))).toBe('New task')
    expect(tabLabel(agentTab('g1'), {}, { g1: 'Fix the header' })).toBe('Fix the header')
    expect(isFileTab(agentTab('g1'))).toBe(false)
    // A task already open in an agent tab is brought forward, not opened a second time.
    const shown = openAgent({ ...fresh, agents: { g1: 'run-1' }, groups: [{ ...fresh.groups[0]!, active: 'a.ts' }] }, 'g2', 'run-1')
    expect(shape(shown)).toEqual([['a.ts', 'agent:g1']])
    expect(shown.groups[0]?.active).toBe('agent:g1')
    // Beside the code, when asked.
    const side = openAgent(one('a.ts'), 'g3', 'run-2', true)
    expect(shape(side)).toEqual([['a.ts'], ['agent:g3']])
    expect(pruneTools(updateGroup(side, 1, (group) => closeTab(group, 'agent:g3'))).agents).toEqual({})
  })

  it('restores the task each agent tab showed', () => {
    const storage = memory()
    const layout = openAgent(openAgent(one('a.ts'), 'g1', 'run-1'), 'g2', null)
    saveLayout(storage, 'p', 'main', layout)
    expect(loadLayout(storage, 'p', 'main').agents).toEqual({ g1: 'run-1', g2: null })
  })
})

describe('what a diff says about lines', () => {
  it('marks added runs, replaced runs and the line after a pure deletion', () => {
    const patch = [
      'diff --git a/a.ts b/a.ts', '--- a/a.ts', '+++ b/a.ts',
      '@@ -1,6 +1,6 @@', ' one', '-two', '+TWO', ' three', '-four', ' five', '+six', ' seven',
      '@@ -20,2 +20,3 @@', ' x', '+y', '+z', '\\ No newline at end of file',
    ].join('\n')
    expect([...lineMarksFromPatch(patch)]).toEqual([[2, 'mod'], [4, 'del'], [5, 'add'], [21, 'add'], [22, 'add']])
    expect(lineMarksFromPatch('').size).toBe(0)
  })

  it('names a language for the status bar', () => {
    expect(languageOf('src/app.tsx')).toBe('TypeScript JSX')
    expect(languageOf('Dockerfile')).toBe('Dockerfile')
    expect(languageOf('apps/api/.env.local')).toBe('Environment')
    expect(languageOf('LICENSE')).toBe('Plain Text')
  })
})

describe('Browser tabs as pages (spec 2026-10-24-code-page-browser-tabs)', () => {
  const one = (...paths: string[]): CodeLayout => ({ ...DEFAULT_LAYOUT, groups: [{ tabs: paths.map((path) => ({ path, preview: false })), active: paths[0] ?? null }] })
  const shape = (layout: CodeLayout) => layout.groups.map((group) => group.tabs.map((tab) => tab.path))
  const A = 'http://localhost:3000/'
  const B = 'http://localhost:3000/admin'

  it('opens, opens beside and closes pages keeping their order', () => {
    let layout = openBrowserTab(one('a.ts'), A, { id: 'b1' })
    layout = openBrowserTab(layout, B, { id: 'b2' })
    expect(shape(layout)).toEqual([['a.ts', 'browser:b1', 'browser:b2']])
    layout = openBrowserTab(layout, '', { id: 'b3', beside: true })
    expect(shape(layout)).toEqual([['a.ts', 'browser:b1', 'browser:b2'], ['browser:b3']])
    expect(layout.focused).toBe(1)
    expect(layout.sizes).toEqual([50, 50])
    layout = pruneTools(updateGroup(layout, 0, (group) => closeTab(group, 'browser:b1')))
    expect(browserTabs(layout)).toEqual([{ id: 'b2', url: B, group: 0 }, { id: 'b3', url: '', group: 1 }])
    expect(focusBrowserTab(layout, 'b2')).toMatchObject({ focused: 0, groups: [{ active: 'browser:b2' }, {}] })
  })

  it('serializes each page\'s url, reads the old { tabs, active } shape, and drops a non-loopback address', () => {
    const storage = memory()
    const layout = openBrowserTab(openBrowserTab(one('a.ts'), B, { id: 'b1' }), 'https://cez.example.com:8502/', { id: 'b2', beside: true })
    saveLayout(storage, 'p', 'main', layout)
    expect(loadLayout(storage, 'p', 'main').browsers).toEqual({ b1: { url: B }, b2: { url: '' } })
    storage.setItem('cez:code:layout:p:main', JSON.stringify({
      groups: [{ tabs: [{ path: 'browser:b1' }, { path: 'browser:b2' }, { path: 'browser:b3' }], active: 'browser:b1' }],
      browsers: { b1: { tabs: ['x', B], active: 1 }, b2: { tabs: ['https://example.com/'], active: 0 }, b3: { url: 'javascript:alert(1)' } },
    }))
    expect(loadLayout(storage, 'p', 'main').browsers).toEqual({ b1: { url: B }, b2: { url: '' }, b3: { url: '' } })
  })

  it('names a page by host:port and path, with the gateway port it is shown through', () => {
    expect(tabLabel(browserTab('b1'), { b1: { url: B } }, {}, { b1: 'https://cez.example.com:8502' })).toBe('localhost:3000/admin → :8502')
  })

  it('sends the server only pages with a loopback address, with their group', () => {
    const layout = openBrowserTab(openBrowserTab(openBrowserTab(one('a.ts'), A, { id: 'b1' }), '', { id: 'b2' }), B, { id: 'b3', beside: true })
    expect(pagesOf(layout)).toEqual([{ id: 'b1', url: A, group: 0 }, { id: 'b3', url: B, group: 1 }])
  })

  it('restores the server\'s pages: its addresses win, a page closed elsewhere closes, a new one opens in its group', () => {
    const local = openBrowserTab(openBrowserTab(openBrowserTab(one('a.ts'), A, { id: 'b1' }), B, { id: 'b2' }), '', { id: 'b3' })
    expect(restorePages(local, undefined)).toBe(local)
    const restored = restorePages(local, [{ id: 'b1', url: B, group: 0 }, { id: 'b9', url: A, group: 1 }])
    expect(shape(restored)).toEqual([['a.ts', 'browser:b1', 'browser:b3'], ['browser:b9']])
    expect(restored.browsers).toEqual({ b1: { url: B }, b3: { url: '' }, b9: { url: A } })
    // A fresh device: nothing local, two pages side by side.
    const fresh = restorePages(DEFAULT_LAYOUT, [{ id: 'b1', url: A, group: 0 }, { id: 'b2', url: B, group: 1 }])
    expect(shape(fresh)).toEqual([['browser:b1'], ['browser:b2']])
    expect(fresh.focused).toBe(0)
  })

  it('keeps the server\'s list per checkout, this one first, salvaging bad entries', () => {
    const raw = [{ tree: 'run-1', pages: [{ id: 'b1', url: A, group: 0 }] }, { tree: 'main', pages: [{ id: 'b1', url: 'https://example.com/', group: 0 }, { id: 'b2', url: B, group: 0 }] }, 'junk']
    expect(savedPagesFor(raw, 'main')).toEqual([{ id: 'b2', url: B, group: 0 }])
    expect(savedPagesFor(raw, 'run-2')).toBeUndefined()
    expect(savedPagesFor(undefined, 'main')).toBeUndefined()
    expect(withPages(raw, 'main', [])).toEqual([{ tree: 'main', pages: [] }, { tree: 'run-1', pages: [{ id: 'b1', url: A, group: 0 }] }])
    const many = Array.from({ length: 12 }, (_, at) => ({ tree: `run-${at}`, pages: [] }))
    expect(withPages(many, 'main', [])).toHaveLength(8)
  })
})
