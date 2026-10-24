import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const running = (url: string) => ({ url, lastSeenAt: '2026-10-20T10:00:00.000Z', running: true })

const getRunTerminalUrls = vi.fn(async (_runId: string) => ({ urls: [running('http://localhost:5177')] }))
const getProjectTerminalUrls = vi.fn(async (): Promise<{ urls: ReturnType<typeof running>[]; sshUser?: string }> => ({
  urls: [running('http://localhost:3570')],
  sshUser: 'kinel',
}))
const openPreviewGateway = vi.fn(async (_input: { target: string; parentOrigin: string }) => ({
  origin: 'https://agents.example.dev:8503',
  ticket: 't',
  ticketParam: 'cezar_ticket',
}))
let localHandoff = true

vi.mock('@/api/client', () => ({
  getRunTerminalUrls: (runId: string) => getRunTerminalUrls(runId),
  getRunTerminalCommands: vi.fn(async () => ({ commands: [] })),
  openPreviewGateway: (input: { target: string; parentOrigin: string }) => openPreviewGateway(input),
}))
vi.mock('@/api/code', () => ({
  getProjectTerminalUrls: () => getProjectTerminalUrls(),
  getProjectTerminalCommands: vi.fn(async () => ({ commands: [] })),
}))
vi.mock('@/api/queries', () => ({
  useHealth: () => ({ data: { capabilities: { localHandoff } } }),
}))
const toast = vi.fn()
vi.mock('@/components/ui/toaster', () => ({ toast: (...args: unknown[]) => toast(...args) }))

const { DetectedUrlsStrip } = await import('./detected-urls-strip')

beforeEach(() => {
  localHandoff = true
  getRunTerminalUrls.mockClear()
  getProjectTerminalUrls.mockClear()
  openPreviewGateway.mockClear()
  toast.mockClear()
})
afterEach(cleanup)

describe('DetectedUrlsStrip (spec 2026-10-24-code-page-terminal §3.1)', () => {
  it('in the task drawer: the user\'s own browser, or the Preview, each from its own control', async () => {
    const onPreview = vi.fn(() => true)
    render(<DetectedUrlsStrip scope={{ kind: 'run', runId: 'r1' }} onPreview={onPreview} />)

    const external = await screen.findByRole('link', { name: 'Open http://localhost:5177 in Browser' })
    expect(external.getAttribute('href')).toBe('http://localhost:5177')
    expect(external.getAttribute('target')).toBe('_blank')
    expect(getRunTerminalUrls).toHaveBeenCalledWith('r1')
    expect(getProjectTerminalUrls).not.toHaveBeenCalled()
    expect(onPreview).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Open http://localhost:5177 in Preview' }))
    expect(onPreview).toHaveBeenCalledWith('http://localhost:5177')
  })

  it('on the Code page: the project\'s own terminals, opened in a Browser tab, nothing on its own', async () => {
    const onOpen = vi.fn()
    render(<DetectedUrlsStrip scope={{ kind: 'project' }} onOpen={onOpen} />)

    const open = await screen.findByRole('button', { name: 'Open http://localhost:3570 in Browser' })
    expect(getProjectTerminalUrls).toHaveBeenCalled()
    expect(getRunTerminalUrls).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: /in Preview/ })).toBeNull()
    expect(onOpen).not.toHaveBeenCalled()
    fireEvent.click(open)
    expect(onOpen).toHaveBeenCalledWith('http://localhost:3570')
    // A local cockpit: the address is the viewer's own, no gateway and no tunnel.
    expect(openPreviewGateway).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'Copy tunnel command' })).toBeNull()
  })

  it('asks nothing while its pane is hidden or the page is in the background', async () => {
    vi.useFakeTimers()
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    try {
      const { rerender } = render(<DetectedUrlsStrip scope={{ kind: 'project' }} onOpen={vi.fn()} active={false} />)
      await vi.advanceTimersByTimeAsync(10_000)
      expect(getProjectTerminalUrls).not.toHaveBeenCalled()

      rerender(<DetectedUrlsStrip scope={{ kind: 'project' }} onOpen={vi.fn()} active />)
      await vi.advanceTimersByTimeAsync(0)
      expect(getProjectTerminalUrls).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(3_000)
      expect(getProjectTerminalUrls).toHaveBeenCalledTimes(2)

      visibility.mockReturnValue('hidden')
      document.dispatchEvent(new Event('visibilitychange'))
      await vi.advanceTimersByTimeAsync(30_000)
      expect(getProjectTerminalUrls).toHaveBeenCalledTimes(2)

      // Back in front: one read at once, then the usual pace.
      visibility.mockReturnValue('visible')
      document.dispatchEvent(new Event('visibilitychange'))
      await vi.advanceTimersByTimeAsync(0)
      expect(getProjectTerminalUrls).toHaveBeenCalledTimes(3)
    } finally {
      visibility.mockRestore()
      vi.useRealTimers()
    }
  })

  it('hosted: says the address goes through the gateway, and opens no gateway port to say so (§3.4)', async () => {
    localHandoff = false
    const onOpen = vi.fn()
    render(<DetectedUrlsStrip scope={{ kind: 'project' }} onOpen={onOpen} />)

    expect(await screen.findByText('→ gateway')).toBeTruthy()
    // Rendering is not a click: no listener is opened, no ticket minted, no Preview evicted.
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(openPreviewGateway).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Open http://localhost:3570 in Browser' }))
    // The Browser tab asks the gateway for its port and ticket itself, on this click.
    expect(onOpen).toHaveBeenCalledWith('http://localhost:3570')
  })

  it('hosted: the tunnel line beside the address, for what the gateway cannot carry', async () => {
    localHandoff = false
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    // A cockpit reached at a real hostname, the only place a tunnel goes to.
    const location = window.location
    Object.defineProperty(window, 'location', { value: { ...location, hostname: 'agents.example.dev', origin: 'https://agents.example.dev' }, configurable: true })
    try {
      render(<DetectedUrlsStrip scope={{ kind: 'project' }} onOpen={vi.fn()} />)
      fireEvent.click(await screen.findByRole('button', { name: 'Copy tunnel command' }))
      await waitFor(() => expect(writeText).toHaveBeenCalledWith('ssh -N -L 3570:localhost:3570 kinel@agents.example.dev'))
      expect(openPreviewGateway).not.toHaveBeenCalled()
    } finally {
      Object.defineProperty(window, 'location', { value: location, configurable: true })
    }
  })
})
