import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import { resetViewport, stubViewport } from '@/test/phone-viewport'

import { phoneBackCrumb } from './app-shell'
import { PhoneGate } from './larger-screen-card'
import { classifyRowGesture, LONG_PRESS_MS, SWIPE_MIN_PX, useRowGestures } from './phone-task-row'

/** The one-column phone layout at 375 px (spec 2026-10-24-mobile-cockpit §3.1, §3.2, §8). */

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  resetViewport()
})

describe('phoneBackCrumb — Projects → Tasks → Thread, one level up at a time', () => {
  const trail = [
    { label: 'demo', to: '/p/demo/' },
    { label: 'Tasks', to: '/p/demo/' },
    { label: 'Fix the login bug' },
  ]

  it('goes from a thread back to the task list', () => {
    expect(phoneBackCrumb(trail, '/p/demo/tasks/r1')).toEqual({ label: 'Tasks', to: '/p/demo/' })
    expect(phoneBackCrumb(trail, '/p/demo/tasks/r1/changes')?.to).toBe('/p/demo/')
  })

  it('has nowhere to go from the task list itself — the sheet is the way to Projects', () => {
    expect(phoneBackCrumb([{ label: 'demo', to: '/p/demo/' }, { label: 'Tasks' }], '/p/demo')).toBeNull()
    expect(phoneBackCrumb([{ label: 'demo', to: '/p/demo/' }], '/p/demo/')).toBeNull()
  })

  it('goes from another page of a project to its tasks', () => {
    expect(phoneBackCrumb([{ label: 'demo', to: '/p/demo/' }, { label: 'Git' }], '/p/demo/git')).toEqual({ label: 'demo', to: '/p/demo/' })
  })
})

describe('PhoneGate — pages with no phone version', () => {
  const renderGate = () =>
    render(
      <QueryClientProvider client={createQueryClient()}>
        <MemoryRouter>
          <PhoneGate page="Code">
            <p>the editor</p>
          </PhoneGate>
        </MemoryRouter>
      </QueryClientProvider>,
    )

  it('shows the larger-screen card at 375 px, naming the page, and never mounts the page', () => {
    stubViewport()
    renderGate()
    expect(document.querySelector('[data-slot="larger-screen-card"]')?.textContent).toContain('Code needs a larger screen')
    expect(screen.queryByText('the editor')).toBeNull()
  })

  it('renders the page itself on a desktop', () => {
    stubViewport(1280)
    renderGate()
    expect(screen.getByText('the editor')).toBeTruthy()
    expect(document.querySelector('[data-slot="larger-screen-card"]')).toBeNull()
  })
})

describe('row gestures', () => {
  it('classifies a swipe right and a long press, and nothing else', () => {
    expect(classifyRowGesture({ x: 10, y: 10 }, { x: 10 + SWIPE_MIN_PX, y: 20 }, 120)).toBe('swipe-right')
    expect(classifyRowGesture({ x: 10, y: 10 }, { x: 10 + SWIPE_MIN_PX, y: 10 + SWIPE_MIN_PX }, 120)).toBeNull()
    expect(classifyRowGesture({ x: 100, y: 10 }, { x: 20, y: 10 }, 120)).toBeNull()
    expect(classifyRowGesture({ x: 10, y: 10 }, { x: 12, y: 11 }, LONG_PRESS_MS)).toBe('long-press')
    expect(classifyRowGesture({ x: 10, y: 10 }, { x: 12, y: 11 }, 80)).toBeNull()
  })

  function Row({ onSwipeRight, onLongPress }: { onSwipeRight: () => void; onLongPress: () => void }) {
    const gestures = useRowGestures({ onSwipeRight, onLongPress })
    return (
      <div data-testid="row" onTouchStart={gestures.onTouchStart} onTouchMove={gestures.onTouchMove} onTouchEnd={gestures.onTouchEnd}>
        row
      </div>
    )
  }

  it('a swipe right opens the thread; a held finger opens the menu while still down', () => {
    vi.useFakeTimers()
    const onSwipeRight = vi.fn()
    const onLongPress = vi.fn()
    render(<Row onSwipeRight={onSwipeRight} onLongPress={onLongPress} />)
    const row = screen.getByTestId('row')

    fireEvent.touchStart(row, { touches: [{ clientX: 10, clientY: 10 }] })
    fireEvent.touchMove(row, { touches: [{ clientX: 90, clientY: 14 }] })
    fireEvent.touchEnd(row, { changedTouches: [{ clientX: 90, clientY: 14 }] })
    expect(onSwipeRight).toHaveBeenCalledOnce()
    vi.advanceTimersByTime(LONG_PRESS_MS)
    expect(onLongPress).not.toHaveBeenCalled()

    fireEvent.touchStart(row, { touches: [{ clientX: 10, clientY: 10 }] })
    vi.advanceTimersByTime(LONG_PRESS_MS)
    expect(onLongPress).toHaveBeenCalledOnce()
    fireEvent.touchEnd(row, { changedTouches: [{ clientX: 10, clientY: 10 }] })
    expect(onSwipeRight).toHaveBeenCalledOnce()
  })
})
