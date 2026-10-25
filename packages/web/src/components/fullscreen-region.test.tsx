import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { TooltipProvider } from '@/components/ui/tooltip'

import { FullscreenRegion, FullscreenToggle } from './fullscreen-region'

/** Spec 2026-10-24-cockpit-polish §3.3: one region takes the window, and gives it back. */

afterEach(() => {
  cleanup()
  delete document.documentElement.dataset.cezFullscreen
})

const region = (label: string) => document.querySelector<HTMLElement>(`[data-fullscreen-region="${label}"]`)!
const isFull = (label: string) => region(label).getAttribute('data-fullscreen') === 'true'

function Two() {
  return (
    <TooltipProvider>
      <FullscreenRegion label="Chat" style={{ width: '40%' }}>
        <button type="button">in chat</button>
        <FullscreenToggle />
      </FullscreenRegion>
      <FullscreenRegion label="Browser">
        <button type="button">in browser</button>
        <div className="xterm">
          <textarea aria-label="shell" />
        </div>
        <FullscreenToggle />
      </FullscreenRegion>
    </TooltipProvider>
  )
}

describe('FullscreenRegion', () => {
  it('enters from its control, covers the window without its column width, and leaves on Esc', () => {
    render(<Two />)
    fireEvent.click(screen.getByRole('button', { name: 'Full screen Chat' }))
    expect(isFull('Chat')).toBe(true)
    expect(region('Chat').className).toContain('fixed')
    expect(region('Chat').style.width).toBe('')
    expect(document.documentElement.dataset.cezFullscreen).toBe('Chat')
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(isFull('Chat')).toBe(false)
    expect(region('Chat').style.width).toBe('40%')
    expect(document.documentElement.dataset.cezFullscreen).toBeUndefined()
  })

  it('F11 goes to the focused region, and F11 again leaves', () => {
    render(<Two />)
    screen.getByRole('button', { name: 'in browser' }).focus()
    fireEvent.keyDown(window, { key: 'F11' })
    expect(isFull('Browser')).toBe(true)
    expect(isFull('Chat')).toBe(false)
    fireEvent.keyDown(window, { key: 'F11' })
    expect(isFull('Browser')).toBe(false)
  })

  it('Ctrl+Cmd+F is the same key', () => {
    render(<Two />)
    screen.getByRole('button', { name: 'in chat' }).focus()
    fireEvent.keyDown(window, { key: 'f', ctrlKey: true, metaKey: true })
    expect(isFull('Chat')).toBe(true)
  })

  it('without a focused region on a screen of several, F11 goes to the one last clicked — or to the browser', () => {
    render(<Two />)
    const unclaimed = new KeyboardEvent('keydown', { key: 'F11', cancelable: true })
    window.dispatchEvent(unclaimed)
    expect(unclaimed.defaultPrevented).toBe(false)
    fireEvent.pointerDown(screen.getByRole('button', { name: 'in browser' }))
    ;(document.activeElement as HTMLElement | null)?.blur()
    fireEvent.keyDown(window, { key: 'F11' })
    expect(isFull('Browser')).toBe(true)
  })

  it('one region at a time: entering another leaves the first', () => {
    render(<Two />)
    fireEvent.click(screen.getByRole('button', { name: 'Full screen Chat' }))
    fireEvent.click(screen.getByRole('button', { name: 'Full screen Browser' }))
    expect(isFull('Chat')).toBe(false)
    expect(isFull('Browser')).toBe(true)
  })

  it('leaves Esc to a shell or an editor, and to an open dialog', () => {
    render(<Two />)
    fireEvent.click(screen.getByRole('button', { name: 'Full screen Browser' }))
    fireEvent.keyDown(screen.getByLabelText('shell'), { key: 'Escape' })
    expect(isFull('Browser')).toBe(true)
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    document.body.append(dialog)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(isFull('Browser')).toBe(true)
    dialog.remove()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(isFull('Browser')).toBe(false)
  })

  it('asks the browser for its full screen, and leaves when the browser does', () => {
    const request = vi.fn(() => Promise.resolve())
    Object.defineProperty(document.documentElement, 'requestFullscreen', { value: request, configurable: true })
    try {
      render(<Two />)
      fireEvent.click(screen.getByRole('button', { name: 'Full screen Chat' }))
      expect(request).toHaveBeenCalledTimes(1)
      act(() => {
        document.dispatchEvent(new Event('fullscreenchange'))
      })
      expect(isFull('Chat')).toBe(false)
    } finally {
      delete (document.documentElement as { requestFullscreen?: unknown }).requestFullscreen
    }
  })

  it('on a screen with one region, F11 anywhere is that region’s — and nothing is persisted', () => {
    const { unmount } = render(
      <FullscreenRegion label="Code">
        <p>editor</p>
      </FullscreenRegion>,
    )
    fireEvent.keyDown(window, { key: 'F11' })
    expect(isFull('Code')).toBe(true)
    unmount()
    render(
      <FullscreenRegion label="Code">
        <p>editor</p>
      </FullscreenRegion>,
    )
    expect(isFull('Code')).toBe(false)
  })

  it('a controlled region reports the change and renders what it is given', () => {
    function Host() {
      const [on, setOn] = useState(false)
      return (
        <FullscreenRegion label="Code" active={on} onActiveChange={setOn}>
          <output data-testid="state">{String(on)}</output>
        </FullscreenRegion>
      )
    }
    render(<Host />)
    fireEvent.keyDown(window, { key: 'F11' })
    expect(screen.getByTestId('state').textContent).toBe('true')
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.getByTestId('state').textContent).toBe('false')
  })

  it('the control renders nothing outside a region', () => {
    render(<FullscreenToggle />)
    expect(document.querySelector('[data-action="fullscreen-region"]')).toBeNull()
  })
})
