import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { BrowserView } from './browser-view'

/**
 * The Browser column on a HOSTED cockpit (spec `.ai/specs/2026-10-10-preview-gateway.md`).
 *
 * `capabilities.preview` is false there: a loopback address would resolve on the viewer's
 * machine. Under test is that such an address is never framed as typed — it goes through the
 * gateway the server answers, or is refused with the server's own reason.
 */

const health = vi.hoisted(() => ({ designMode: false }))
vi.mock('@/api/queries', () => ({
  useHealth: () => ({ data: { capabilities: { preview: false, designMode: health.designMode } } }),
}))

const openPreviewGateway = vi.hoisted(() => vi.fn())
vi.mock('@/api/client', () => ({ openDesignProxy: vi.fn(), openPreviewGateway }))

vi.mock('@/components/ui/toaster', () => ({ toast: vi.fn() }))

const APP = 'http://localhost:3000/cart?step=2'
const GATEWAY = 'https://cezar.example.com:8501'

const frame = () => document.querySelector('iframe')

function renderView(address = APP) {
  const onChange = vi.fn()
  render(<BrowserView state={{ tabs: [address], active: 0 }} onChange={onChange} />)
  return { onChange }
}

beforeEach(() => {
  health.designMode = false
  openPreviewGateway.mockReset().mockResolvedValue({ origin: GATEWAY, ticket: 'T1', ticketParam: '__cez_preview' })
})
afterEach(cleanup)

describe('a loopback address on a hosted cockpit', () => {
  it('is framed through the gateway, with its path and a ticket, and never as typed', async () => {
    renderView()
    // Before the server answers there is no frame at all — not even one pointed at localhost.
    expect(frame()).toBeNull()

    await waitFor(() => expect(frame()).not.toBeNull())
    expect(frame()!.getAttribute('src')).toBe(`${GATEWAY}/cart?step=2&__cez_preview=T1`)
    expect(openPreviewGateway).toHaveBeenCalledWith({ target: 'http://localhost:3000', parentOrigin: window.location.origin })
  })

  it('keeps the address the user typed as the saved one, not the gateway’s', async () => {
    const { onChange } = renderView()
    await waitFor(() => expect(frame()).not.toBeNull())
    frame()!.dispatchEvent(new Event('load'))
    for (const [state] of onChange.mock.calls as Array<[{ tabs: string[] }]>) {
      expect(state.tabs.join(' ')).not.toContain(GATEWAY)
    }
  })

  it('is refused with the server’s reason when this cockpit has no gateway', async () => {
    openPreviewGateway.mockRejectedValue(new Error('this cockpit has no preview gateway (CEZ_PREVIEW_PORTS is not set)'))
    renderView()

    expect(await screen.findByText('This address points at the machine you are sitting at')).toBeTruthy()
    expect(screen.getByText(/CEZ_PREVIEW_PORTS is not set/)).toBeTruthy()
    expect(frame()).toBeNull()
  })

  it('reports the gateway origin it frames through, for a tab title (Code page browser tabs §3)', async () => {
    const onGateway = vi.fn()
    render(<BrowserView state={{ tabs: [APP], active: 0 }} onChange={() => {}} onGateway={onGateway} />)
    await waitFor(() => expect(onGateway).toHaveBeenLastCalledWith(GATEWAY))
    expect(onGateway).toHaveBeenCalledWith(null)
  })

  it('leaves an address that is not local alone', async () => {
    renderView('https://github.com/')
    expect(frame()!.getAttribute('src')).toBe('https://github.com/')
    expect(openPreviewGateway).not.toHaveBeenCalled()
  })
})

describe('an empty tab on a hosted cockpit', () => {
  it('is left to the address bar: there is no local app to run from here', () => {
    render(<BrowserView state={{ tabs: [''], active: 0 }} onChange={() => {}} renderEmpty={() => <p>run panel</p>} />)
    expect(screen.queryByText('run panel')).toBeNull()
    expect(screen.getByText('Empty tab')).toBeTruthy()
  })
})

describe('Design Mode on a hosted cockpit (spec 2026-10-24-design-mode-third-cut §3.4)', () => {
  const DESIGN_SLOT = 'https://cezar.example.com:8502'

  it('asks the gateway for a design slot, frames it, and believes only that slot’s picker', async () => {
    health.designMode = true
    openPreviewGateway.mockImplementation(async (input: { designMode?: boolean }) =>
      input.designMode ? { origin: DESIGN_SLOT, ticket: 'D1', ticketParam: '__cez_preview' } : { origin: GATEWAY, ticket: 'T1', ticketParam: '__cez_preview' },
    )
    const onPickElement = vi.fn(() => true)
    render(<BrowserView state={{ tabs: [APP], active: 0 }} onChange={vi.fn()} onPickElement={onPickElement} />)
    await waitFor(() => expect(frame()?.getAttribute('src')).toBe(`${GATEWAY}/cart?step=2&__cez_preview=T1`))

    fireEvent.click(screen.getByRole('button', { name: 'Design Mode' }))
    await waitFor(() => expect(frame()?.getAttribute('src')).toBe(`${DESIGN_SLOT}/cart?step=2&__cez_preview=D1`))
    expect(openPreviewGateway).toHaveBeenLastCalledWith({ target: 'http://localhost:3000', parentOrigin: window.location.origin, designMode: true })
    await act(async () => {})

    const element = { url: APP, selector: 'main > button', tag: 'button', text: '', html: '<button></button>', styles: {}, rect: { x: 0, y: 0, width: 1, height: 1 }, viewport: { width: 1, height: 1 }, components: [] }
    const deliver = (origin: string) =>
      act(() => {
        window.dispatchEvent(new MessageEvent('message', { data: { source: 'cezar-design', type: 'picked', element }, origin, source: frame()!.contentWindow }))
      })
    deliver(GATEWAY)
    expect(onPickElement).not.toHaveBeenCalled()
    deliver(DESIGN_SLOT)
    expect(onPickElement).toHaveBeenCalledWith(element)
  })

  it('falls back to a plain preview, with the reason, when the design slot is refused', async () => {
    health.designMode = true
    openPreviewGateway.mockImplementation(async (input: { designMode?: boolean }) => {
      if (input.designMode) throw new Error('Design Mode is not available on this cockpit')
      return { origin: GATEWAY, ticket: 'T2', ticketParam: '__cez_preview' }
    })
    render(<BrowserView state={{ tabs: [APP], active: 0 }} onChange={vi.fn()} onPickElement={vi.fn(() => true)} />)
    await waitFor(() => expect(frame()).not.toBeNull())
    fireEvent.click(screen.getByRole('button', { name: 'Design Mode' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Design Mode' }).getAttribute('aria-pressed')).toBe('false'))
    await waitFor(() => expect(frame()?.getAttribute('src')).toBe(`${GATEWAY}/cart?step=2&__cez_preview=T2`))
  })
})
