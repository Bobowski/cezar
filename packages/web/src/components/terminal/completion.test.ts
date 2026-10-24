import { describe, expect, it, vi } from 'vitest'

import { CompletionController, LineTracker, childrenOf, filterHistory, rankCompletions, type CompletionSources, type CompletionView } from './completion'

const sources: CompletionSources = {
  commands: ['npm run dev', 'npm run test', 'make test'],
  history: ['npm run dev -- --host', 'npm run test', 'git status'],
  paths: ['package.json', 'src/app.ts', 'src/lib/util.ts', 'scripts/dev.mjs', 'README.md'],
}

describe('rankCompletions (spec 2026-10-24-code-page-terminal §3.3)', () => {
  it('ranks discovered commands, then history, then paths — by prefix, each line once', () => {
    expect(rankCompletions('npm run ', sources).map((item) => [item.line, item.source])).toEqual([
      ['npm run dev', 'command'],
      ['npm run test', 'command'],
      // `npm run test` is in the history too; the command already offered it.
      ['npm run dev -- --host', 'history'],
    ])
    expect(rankCompletions('npm run t', sources).map((item) => item.insert)).toEqual(['est'])
  })

  it('completes the token under the cursor from one level of the tree', () => {
    expect(rankCompletions('cat s', sources).map((item) => item.line)).toEqual(['cat scripts/', 'cat src/'])
    expect(rankCompletions('cat src/', sources).map((item) => item.insert)).toEqual(['app.ts', 'lib/'])
    expect(rankCompletions('vim ./src/a', sources).map((item) => item.line)).toEqual(['vim ./src/app.ts'])
    // A flag is no path, and an empty token lists the tree only when asked.
    expect(rankCompletions('ls -', sources)).toEqual([])
    expect(rankCompletions('ls ', sources)).toEqual([])
    expect(rankCompletions('ls ', sources, { explicit: true }).map((item) => item.line)).toContain('ls src/')
  })

  it('never offers the line itself, and caps the list', () => {
    expect(rankCompletions('git status', sources)).toEqual([])
    const many = { ...sources, history: Array.from({ length: 30 }, (_, index) => `echo ${index}`) }
    expect(rankCompletions('echo', many)).toHaveLength(8)
  })

  it('lists one level of a directory, directories marked', () => {
    expect(childrenOf(sources.paths, '')).toEqual(['package.json', 'README.md', 'scripts/', 'src/'])
    expect(childrenOf(sources.paths, 'src/')).toEqual(['app.ts', 'lib/'])
  })

  it('filters history by substring for Ctrl+R, newest first', () => {
    expect(filterHistory(sources.history, 'RUN')).toEqual(['npm run dev -- --host', 'npm run test'])
  })
})

describe('LineTracker', () => {
  it('knows a typed line until the shell takes over editing it', () => {
    const tracker = new LineTracker()
    tracker.feed('npm ru')
    tracker.feed('x\x7fn')
    expect(tracker.line).toBe('npm run')
    tracker.feed('\x1b[D')
    expect(tracker.line).toBeNull()
    expect(tracker.feed('\r')).toBe(false)
    expect(tracker.line).toBe('')
    tracker.feed('ls')
    expect(tracker.feed('\r')).toBe(true)
  })
})

describe('CompletionController', () => {
  const setup = () => {
    const written: string[] = []
    const views: CompletionView[] = []
    let fire: (() => void) | null = null
    const onSubmitted = vi.fn()
    const controller = new CompletionController({
      write: (data) => written.push(data),
      sources: () => sources,
      onView: (view) => views.push(view),
      onSubmitted,
      schedule: (run) => {
        fire = run
        return () => {
          fire = null
        }
      },
    })
    const key = (name: string, mods: Partial<{ ctrlKey: boolean; shiftKey: boolean }> = {}) =>
      controller.key({ key: name, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods })
    return { controller, written, views, key, onSubmitted, fire: () => fire?.() }
  }

  it('Tab lists what fits and Tab again writes the rest of the line, as if typed', () => {
    const { controller, written, key } = setup()
    controller.typed('npm run ')
    expect(key('Tab')).toBe(false)
    expect(controller.current?.mode).toBe('complete')
    expect(key('ArrowDown')).toBe(false)
    expect(key('Tab')).toBe(false)
    expect(written).toEqual(['test'])
    expect(controller.current).toBeNull()
  })

  it('leaves Tab to the shell when there is nothing to offer, or after Esc', () => {
    const { controller, key } = setup()
    controller.typed('zz')
    expect(key('Tab')).toBe(true)
    controller.typed('\x15make')
    expect(key('Tab')).toBe(false)
    expect(key('Escape')).toBe(false)
    expect(controller.current).toBeNull()
    expect(key('Tab')).toBe(true)
    // A new line: the popover is back.
    controller.typed('\rmak')
    expect(key('Tab')).toBe(false)
  })

  it('shows by itself after a pause, once two characters are typed', () => {
    const { controller, fire } = setup()
    controller.typed('n')
    fire()
    expect(controller.current).toBeNull()
    controller.typed('p')
    fire()
    expect(controller.current?.mode).toBe('complete')
    // Typing on refilters; a line the shell edits closes it.
    controller.typed('m run d')
    expect(controller.current?.mode === 'complete' && controller.current.items.map((item) => item.line)).toEqual(['npm run dev', 'npm run dev -- --host'])
    controller.typed('\x1b[A')
    expect(controller.current).toBeNull()
  })

  it('Ctrl+R picks a history line in place of the one typed, without running it', () => {
    const { controller, written, key, onSubmitted } = setup()
    controller.typed('gi')
    expect(key('r', { ctrlKey: true })).toBe(false)
    controller.setHistoryFilter('stat')
    expect(controller.current?.mode === 'history' && controller.current.items).toEqual(['git status'])
    controller.pickHistory('git status')
    expect(written).toEqual(['\x7f\x7fgit status'])
    expect(onSubmitted).not.toHaveBeenCalled()
    controller.typed('\r')
    expect(onSubmitted).toHaveBeenCalledTimes(1)
  })
})
