import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * The Code terminal's pane wiring (spec `.ai/specs/2026-10-24-code-page-terminal.md` §3.2–§3.3):
 * a key the completion takes never reaches the shell, an accepted item is written as if typed,
 * and links are attached only where the page asked for them.
 */

vi.mock('@/api/client', () => ({
  resizeRunTerminal: vi.fn(async () => ({})),
  writeRunTerminal: vi.fn(async () => ({})),
  readRunTerminal: vi.fn(async () => ({ data: '', cursor: 0, truncated: false, exitCode: null })),
}))
vi.mock('@/api/host-usage', () => ({ useHostTransport: () => 'poll' as const }))
vi.mock('@/api/ws', () => ({ subscribeTopic: () => () => {} }))
vi.mock('@xterm/xterm/css/xterm.css', () => ({}))

type KeyHandler = (event: KeyboardEvent) => boolean
let term: FakeTerminal | null = null
const linkProviders: unknown[] = []
const webLinks = vi.fn()

class FakeTerminal {
  cols = 80
  rows = 24
  buffer = { active: { cursorX: 8, cursorY: 2, type: 'normal' as 'normal' | 'alternate' } }
  keyHandler: KeyHandler = () => true
  dataHandler: (data: string) => void = () => {}
  onResize() {}
  onData(handler: (data: string) => void) {
    this.dataHandler = handler
  }
  attachCustomKeyEventHandler(handler: KeyHandler) {
    this.keyHandler = handler
  }
  registerLinkProvider(provider: unknown) {
    linkProviders.push(provider)
    return { dispose() {} }
  }
  hasSelection() {
    return false
  }
  getSelection() {
    return ''
  }
  loadAddon() {}
  open() {}
  focus() {}
  write() {}
  dispose() {}
  /** What xterm does with a keydown: ask the handler, then turn an unhandled key into data. */
  press(key: string, data: string) {
    const event = new KeyboardEvent('keydown', { key, cancelable: true })
    if (this.keyHandler(event)) this.dataHandler(data)
    return event
  }
}

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    constructor() {
      term = new FakeTerminal()
      return term as unknown as this
    }
  },
}))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }))
vi.mock('@xterm/addon-web-links', () => ({
  WebLinksAddon: class {
    constructor(...args: unknown[]) {
      webLinks(...args)
    }
    dispose() {}
  },
}))

const { TerminalPane } = await import('./terminal-pane')

const SESSION = { id: 's-1', exitCode: null, topic: null }

afterEach(() => {
  cleanup()
  term = null
  linkProviders.length = 0
  webLinks.mockClear()
})

describe('TerminalPane — the Code terminal\'s completion and links', () => {
  it('Tab opens the list instead of reaching the shell, and Tab again writes the rest', async () => {
    const written: string[] = []
    const io = { read: vi.fn(async () => ({ data: '', cursor: 0, truncated: false, exitCode: null })), write: vi.fn(async (data: string) => { written.push(data) }), resize: vi.fn(async () => {}) }
    render(
      <TerminalPane runId="" io={io} session={SESSION} active completion={{ commands: ['npm run dev'], history: [], paths: [] }} />,
    )
    await waitFor(() => expect(term).not.toBeNull())
    act(() => {
      for (const key of 'npm run ') term!.press(key, key)
    })
    let tab!: KeyboardEvent
    act(() => {
      tab = term!.press('Tab', '\t')
    })
    expect(tab.defaultPrevented).toBe(true)
    expect(await screen.findByRole('listbox', { name: 'Completions' })).toBeTruthy()
    act(() => {
      term!.press('Tab', '\t')
    })
    expect(written.join('')).toBe('npm run dev')
    expect(written).not.toContain('\t')
    expect(screen.queryByRole('listbox', { name: 'Completions' })).toBeNull()
  })

  it('on the alternate screen, Tab is the program\'s', async () => {
    const io = { read: vi.fn(async () => ({ data: '', cursor: 0, truncated: false, exitCode: null })), write: vi.fn(async () => {}), resize: vi.fn(async () => {}) }
    render(
      <TerminalPane runId="" io={io} session={SESSION} active completion={{ commands: ['npm run dev'], history: [], paths: [], atPrompt: async () => true }} />,
    )
    await waitFor(() => expect(term).not.toBeNull())
    await act(async () => {})
    // vim switched to the alternate screen; what it is typed is not a shell line.
    term!.buffer.active.type = 'alternate'
    act(() => {
      for (const key of 'npm run ') term!.press(key, key)
      term!.press('Tab', '\t')
    })
    expect(io.write).toHaveBeenCalledWith('\t')
    expect(screen.queryByRole('listbox', { name: 'Completions' })).toBeNull()
  })

  it('while the shell runs a program, Tab is the program\'s', async () => {
    const atPrompt = vi.fn(async (sessionId: string) => sessionId !== 's-1')
    const io = { read: vi.fn(async () => ({ data: '', cursor: 0, truncated: false, exitCode: null })), write: vi.fn(async () => {}), resize: vi.fn(async () => {}) }
    render(
      <TerminalPane runId="" io={io} session={SESSION} active completion={{ commands: ['npm run dev'], history: [], paths: [], atPrompt }} />,
    )
    await waitFor(() => expect(atPrompt).toHaveBeenCalledWith('s-1'))
    await act(async () => {})
    act(() => {
      for (const key of 'npm run ') term!.press(key, key)
      term!.press('Tab', '\t')
    })
    expect(io.write).toHaveBeenCalledWith('\t')
  })

  it('without completion, Tab is the shell\'s and no list is drawn', async () => {
    const io = { read: vi.fn(async () => ({ data: '', cursor: 0, truncated: false, exitCode: null })), write: vi.fn(async () => {}), resize: vi.fn(async () => {}) }
    render(<TerminalPane runId="" io={io} session={SESSION} active />)
    await waitFor(() => expect(term).not.toBeNull())
    act(() => {
      term!.press('Tab', '\t')
    })
    expect(io.write).toHaveBeenCalledWith('\t')
    expect(linkProviders).toHaveLength(0)
    expect(webLinks).not.toHaveBeenCalled()
  })

  it('attaches the web-links addon and the bare-address provider where links were asked for', async () => {
    const onOpenBrowser = vi.fn()
    const io = { read: vi.fn(async () => ({ data: '', cursor: 0, truncated: false, exitCode: null })), write: vi.fn(async () => {}), resize: vi.fn(async () => {}) }
    render(<TerminalPane runId="" io={io} session={SESSION} active onOpenBrowser={onOpenBrowser} />)
    await waitFor(() => expect(webLinks).toHaveBeenCalled())
    expect(linkProviders).toHaveLength(1)
    const activate = webLinks.mock.calls[0]?.[0] as (event: MouseEvent, uri: string) => void
    activate(new MouseEvent('click'), 'http://0.0.0.0:3000/')
    expect(onOpenBrowser).toHaveBeenCalledWith('http://localhost:3000/')
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    activate(new MouseEvent('click'), 'https://docs.npmjs.com/')
    expect(open).toHaveBeenCalledWith('https://docs.npmjs.com/', '_blank', 'noopener,noreferrer')
    expect(onOpenBrowser).toHaveBeenCalledTimes(1)
  })
})
