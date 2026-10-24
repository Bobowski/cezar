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

  it('hosted: shows the gateway port a running address is served on (§3.4)', async () => {
    localHandoff = false
    render(<DetectedUrlsStrip scope={{ kind: 'project' }} onOpen={vi.fn()} />)

    expect(await screen.findByText('→ :8503')).toBeTruthy()
    expect(openPreviewGateway).toHaveBeenCalledTimes(1)
    expect(openPreviewGateway.mock.calls[0]?.[0]).toEqual({ target: 'http://localhost:3570', parentOrigin: window.location.origin })
    expect(screen.getByRole('button', { name: 'Open http://localhost:3570 in Browser' })).toBeTruthy()
  })

  it('hosted with no free gateway port: the tunnel line instead of a dead link', async () => {
    localHandoff = false
    openPreviewGateway.mockRejectedValueOnce(new Error('every preview port is in use — close a preview and retry'))
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    // A cockpit reached at a real hostname, the only place a tunnel goes to.
    const location = window.location
    Object.defineProperty(window, 'location', { value: { ...location, hostname: 'agents.example.dev', origin: 'https://agents.example.dev' }, configurable: true })
    try {
      render(<DetectedUrlsStrip scope={{ kind: 'project' }} onOpen={vi.fn()} />)
      // Once the gateway has refused: the line leads, and the dead link is gone.
      await screen.findByText('Copy tunnel command')
      const copy = screen.getByRole('button', { name: 'Copy tunnel command' })
      expect(screen.queryByRole('button', { name: 'Open http://localhost:3570 in Browser' })).toBeNull()
      fireEvent.click(copy)
      await waitFor(() => expect(writeText).toHaveBeenCalledWith('ssh -N -L 3570:localhost:3570 kinel@agents.example.dev'))
    } finally {
      Object.defineProperty(window, 'location', { value: location, configurable: true })
    }
  })
})
