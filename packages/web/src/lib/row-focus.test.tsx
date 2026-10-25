import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { openOnEnter, ROW_FOCUS_CLASS } from './row-focus'

/** Clickable rows (spec 2026-10-24-cockpit-polish §3.4 item 2). */

afterEach(cleanup)

describe('openOnEnter', () => {
  it('makes the row a focus stop that opens on Enter — its own Enter only', () => {
    const open = vi.fn()
    render(
      <div data-testid="row" className={ROW_FOCUS_CLASS} {...openOnEnter(open)}>
        <input aria-label="inside" />
      </div>,
    )
    const row = screen.getByTestId('row')
    expect(row.tabIndex).toBe(0)
    expect(row.className).toContain('focus-visible:ring-2')
    fireEvent.keyDown(screen.getByLabelText('inside'), { key: 'Enter' })
    expect(open).not.toHaveBeenCalled()
    fireEvent.keyDown(row, { key: ' ' })
    expect(open).not.toHaveBeenCalled()
    fireEvent.keyDown(row, { key: 'Enter' })
    expect(open).toHaveBeenCalledTimes(1)
  })
})
