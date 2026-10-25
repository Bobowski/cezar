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

  it('the last-clicked fallback ends when focus moves outside every region: F11 is the browser’s again', () => {
    render(
      <>
        <Two />
        <a href="#elsewhere">sidebar link</a>
      </>,
    )
    fireEvent.pointerDown(screen.getByRole('button', { name: 'in browser' }))
    screen.getByRole('link', { name: 'sidebar link' }).focus()
    ;(document.activeElement as HTMLElement | null)?.blur()
    const unclaimed = new KeyboardEvent('keydown', { key: 'F11', cancelable: true })
    window.dispatchEvent(unclaimed)
    expect(unclaimed.defaultPrevented).toBe(false)
    expect(isFull('Browser')).toBe(false)
    // Focus inside a region keeps it: the click then the region's own focus.
    fireEvent.pointerDown(screen.getByRole('button', { name: 'in chat' }))
    screen.getByRole('button', { name: 'in chat' }).focus()
    ;(document.activeElement as HTMLElement | null)?.blur()
    fireEvent.keyDown(window, { key: 'F11' })
    expect(isFull('Chat')).toBe(true)
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

  it('is a layout state: never the browser’s Fullscreen API, so the browser cannot take Esc or the region', () => {
    const request = vi.fn(() => Promise.resolve())
    Object.defineProperty(document.documentElement, 'requestFullscreen', { value: request, configurable: true })
    try {
      render(<Two />)
      fireEvent.click(screen.getByRole('button', { name: 'Full screen Chat' }))
      fireEvent.keyDown(window, { key: 'F11' })
      expect(isFull('Chat')).toBe(false)
      screen.getByRole('button', { name: 'in chat' }).focus()
      fireEvent.keyDown(window, { key: 'F11' })
      expect(request).not.toHaveBeenCalled()
      expect(isFull('Chat')).toBe(true)
      // A browser leaving its own full screen (its Esc, its F11) is not this region's business.
      act(() => {
        document.dispatchEvent(new Event('fullscreenchange'))
      })
      expect(isFull('Chat')).toBe(true)
    } finally {
      delete (document.documentElement as { requestFullscreen?: unknown }).requestFullscreen
    }
  })

  it('Esc goes to an open dialog first, then an editor, and only then leaves full screen', () => {
    render(
      <TooltipProvider>
        <FullscreenRegion label="Code">
          <div className="cm-editor">
            <textarea aria-label="editor" />
          </div>
          <button type="button">plain</button>
          <FullscreenToggle />
        </FullscreenRegion>
      </TooltipProvider>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Full screen Code' }))
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'alertdialog')
    document.body.append(dialog)
    fireEvent.keyDown(screen.getByRole('button', { name: 'plain' }), { key: 'Escape' })
    expect(isFull('Code')).toBe(true)
    dialog.remove()
    fireEvent.keyDown(screen.getByLabelText('editor'), { key: 'Escape' })
    expect(isFull('Code')).toBe(true)
    // A handler that took the key (a popover closing itself) wins too.
    const taken = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    taken.preventDefault()
    window.dispatchEvent(taken)
    expect(isFull('Code')).toBe(true)
    fireEvent.keyDown(screen.getByRole('button', { name: 'plain' }), { key: 'Escape' })
    expect(isFull('Code')).toBe(false)
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
