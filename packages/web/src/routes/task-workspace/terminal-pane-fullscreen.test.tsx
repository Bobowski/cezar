import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { FullscreenRegion } from '@/components/fullscreen-region'

/**
 * Full screen's keys from inside a shell (spec `.ai/specs/2026-10-24-cockpit-polish.md` §3.3):
 * xterm cancels every key it turns into bytes, so F11 and Esc never reached the region. Driven
 * through the REAL xterm, because that cancel is the seam.
 */

vi.mock('@/api/host-usage', () => ({ useHostTransport: () => 'poll' as const }))
vi.mock('@/api/ws', () => ({ subscribeTopic: () => () => {} }))
vi.mock('@xterm/xterm/css/xterm.css', () => ({}))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} activate() {} dispose() {} } }))

const { TerminalPane } = await import('./terminal-pane')

const write = vi.fn(async (_data: string) => {})
let screen = ''
const io = {
  read: async (cursor: number) => ({ data: cursor === 0 ? screen : '', cursor: screen.length, truncated: false, exitCode: null }),
  write,
  resize: async () => {},
}

beforeEach(() => {
  write.mockClear()
  screen = ''
  vi.stubGlobal('matchMedia', () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }))
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

async function mount() {
  render(
    <FullscreenRegion label="Terminal">
      <TerminalPane runId="r1" session={{ id: 's-1', exitCode: null, topic: 's-1' }} active io={io} />
    </FullscreenRegion>,
  )
  return waitFor(() => {
    const found = document.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea')
    expect(found).not.toBeNull()
    return found!
  })
}
const region = () => document.querySelector('[data-fullscreen-region="Terminal"]')!
const press = (textarea: HTMLTextAreaElement, key: string) =>
  // xterm reads the legacy keyCode to pick the bytes.
  textarea.dispatchEvent(new KeyboardEvent('keydown', { key, keyCode: key === 'F11' ? 122 : 27, bubbles: true, cancelable: true }))
const sent = async () => {
  await new Promise((resolve) => setTimeout(resolve, 20))
  return write.mock.calls.map((call) => call[0])
}

describe('TerminalPane — full screen keys', () => {
  it('F11 in the shell fullscreens the drawer, Esc at the prompt leaves it, and neither reaches the PTY', async () => {
    const textarea = await mount()
    press(textarea, 'F11')
    await waitFor(() => expect(region().getAttribute('data-fullscreen')).toBe('true'))
    press(textarea, 'Escape')
    await waitFor(() => expect(region().getAttribute('data-fullscreen')).toBeNull())
    expect(await sent()).toEqual([])
  })

  it('outside full screen, Esc is the shell’s', async () => {
    const textarea = await mount()
    press(textarea, 'Escape')
    expect(await sent()).toEqual(['\x1b'])
  })

  it('a program on the alternate screen (vim, less) keeps Esc, and full screen stays', async () => {
    screen = '\x1b[?1049h'
    const textarea = await mount()
    // Let the first pull draw the program's screen.
    await new Promise((resolve) => setTimeout(resolve, 100))
    press(textarea, 'F11')
    await waitFor(() => expect(region().getAttribute('data-fullscreen')).toBe('true'))
    press(textarea, 'Escape')
    expect(await sent()).toEqual(['\x1b'])
    expect(region().getAttribute('data-fullscreen')).toBe('true')
  })
})
