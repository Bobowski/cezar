import { describe, expect, it, vi } from 'vitest'

import {
  AUTO_DELAY_MS, CompletionController, LineTracker, PROMPT_RECHECK_MS, childrenOf, filterHistory, rankCompletions, type CompletionSources, type CompletionView,
  type PromptState,
} from './completion'

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
    // A flag is no path, and an empty token is none either — not even when asked.
    expect(rankCompletions('ls -', sources)).toEqual([])
    expect(rankCompletions('ls ', sources)).toEqual([])
    expect(rankCompletions('ls ', sources, { explicit: true })).toEqual([])
  })

  it('completes paths from the shell\'s own directory when it is known', () => {
    expect(rankCompletions('cat a', sources, { dir: 'src/' }).map((item) => item.line)).toEqual(['cat app.ts'])
    expect(rankCompletions('vim lib/u', sources, { dir: 'src/' }).map((item) => item.insert)).toEqual(['til.ts'])
    expect(rankCompletions('cat ../s', sources, { dir: 'src/' }).map((item) => item.line)).toEqual(['cat ../scripts/', 'cat ../src/'])
    // Above the checkout, or a shell that left it: the tree has nothing to say.
    expect(rankCompletions('cat ../s', sources, { dir: '' })).toEqual([])
    expect(rankCompletions('cat s', sources, { dir: null })).toEqual([])
    // Unknown (no `/proc` on this host): the checkout root.
    expect(rankCompletions('cat s', sources, { dir: undefined }).map((item) => item.line)).toEqual(['cat scripts/', 'cat src/'])
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

  describe('only at the shell\'s prompt', () => {
    const gated = () => {
      const timers = new Map<number, () => void>()
      const answers: Array<(atPrompt: boolean) => void> = []
      let alternate = false
      const written: string[] = []
      const controller = new CompletionController({
        write: (data) => written.push(data),
        sources: () => sources,
        onView: () => {},
        schedule: (run, ms) => {
          timers.set(ms, run)
          return () => timers.delete(ms)
        },
        alternateScreen: () => alternate,
        promptCheck: () => new Promise<PromptState>((resolve) => answers.push((atPrompt) => resolve({ atPrompt }))),
      })
      const key = (name: string, mods: Partial<{ ctrlKey: boolean }> = {}) =>
        controller.key({ key: name, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods })
      const answer = async (atPrompt: boolean) => {
        answers.shift()?.(atPrompt)
        await Promise.resolve()
      }
      return { controller, key, answer, timers, written, setAlternate: (value: boolean) => { alternate = value } }
    }

    it('takes no key in a program the shell is running, until a check after Enter finds the prompt', async () => {
      const { controller, key, answer, timers } = gated()
      await answer(true)
      controller.typed('python3\r')
      // The REPL owns its keys: Tab, Ctrl+R and an auto popover are all its own.
      controller.typed('pr')
      expect(key('Tab')).toBe(true)
      expect(key('r', { ctrlKey: true })).toBe(true)
      timers.get(AUTO_DELAY_MS)?.()
      expect(controller.current).toBeNull()
      // The re-check waits past the server's one-second process-table reuse.
      timers.get(PROMPT_RECHECK_MS)!()
      await answer(false)
      expect(key('Tab')).toBe(true)
      controller.typed('exit()\r')
      timers.get(PROMPT_RECHECK_MS)!()
      await answer(true)
      controller.typed('npm run ')
      expect(key('Tab')).toBe(false)
      expect(controller.current?.mode).toBe('complete')
    })

    it('is off before the first answer, and on Ctrl+C asks again', async () => {
      const { controller, key, answer, timers } = gated()
      controller.typed('npm run ')
      expect(key('Tab')).toBe(true)
      await answer(false)
      controller.typed('\x03')
      timers.get(PROMPT_RECHECK_MS)!()
      await answer(true)
      controller.typed('npm run ')
      expect(key('Tab')).toBe(false)
    })

    it('takes no key on the alternate screen (vim, less, htop), whatever the process table said', async () => {
      const { controller, key, answer, setAlternate } = gated()
      await answer(true)
      setAlternate(true)
      controller.typed('npm run ')
      expect(key('Tab')).toBe(true)
      expect(key('r', { ctrlKey: true })).toBe(true)
      expect(key('Escape')).toBe(true)
      expect(controller.current).toBeNull()
    })

    it('lists paths from the directory the prompt check reported', async () => {
      const controller = new CompletionController({
        write: () => {},
        sources: () => sources,
        onView: () => {},
        schedule: () => () => {},
        promptCheck: async () => ({ atPrompt: true, dir: 'src/' }),
      })
      await Promise.resolve()
      await Promise.resolve()
      controller.typed('cat a')
      expect(controller.key({ key: 'Tab', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false })).toBe(false)
      expect(controller.current?.mode === 'complete' && controller.current.items.map((item) => item.line)).toEqual(['cat app.ts'])
    })

    it('consumes Esc only while the popover is open', async () => {
      const { controller, key, answer } = gated()
      await answer(true)
      expect(key('Escape')).toBe(true)
      controller.typed('npm run ')
      expect(key('Tab')).toBe(false)
      expect(key('Escape')).toBe(false)
      expect(key('Escape')).toBe(true)
    })
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
