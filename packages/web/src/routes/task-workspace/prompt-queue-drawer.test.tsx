import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ApiRun } from '@open-mercato/cezar-api-client'

import type { DesignNote } from './design-notes'

const api = vi.hoisted(() => ({
  editQueuedRunPrompt: vi.fn(),
  removeQueuedRunPrompt: vi.fn(),
  reorderRunPromptQueue: vi.fn(),
}))
vi.mock('@/api/client', () => api)
vi.mock('@/components/ui/toaster', () => ({ toast: vi.fn() }))

import { PromptQueueDrawer } from './prompt-queue-drawer'

/** The Queue drawer (spec 2026-10-24-design-mode-third-cut §3.1): lists, edits, reorders, removes. */

const run = {
  id: 'run-1',
  status: 'running',
  promptQueue: [
    { id: 'a', text: 'first follow-up', createdAt: '2026-10-24T00:00:00.000Z' },
    { id: 'b', text: 'second follow-up', createdAt: '2026-10-24T00:00:01.000Z' },
  ],
} as unknown as ApiRun

const notes = (over: Partial<{ notes: DesignNote[] }> = {}) => ({
  notes: [] as DesignNote[],
  saveQueued: vi.fn(async () => {}),
  withdraw: vi.fn(async () => {}),
  ...over,
})

const open = () => {
  fireEvent.click(screen.getByRole('button', { name: 'Queue, 2 waiting' }))
  return screen.findAllByRole('listitem')
}

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset().mockResolvedValue({})
})
afterEach(cleanup)

describe('the Queue drawer', () => {
  it('shows how many prompts wait, and lists them in order', async () => {
    render(<PromptQueueDrawer run={run} notes={notes()} />)
    const rows = await open()
    expect(rows.map((row) => within(row).getByText(/follow-up/).textContent)).toEqual(['first follow-up', 'second follow-up'])
  })

  it('moves a prompt, sending the whole new order', async () => {
    render(<PromptQueueDrawer run={run} notes={notes()} />)
    const [first] = await open()
    fireEvent.click(within(first!).getByRole('button', { name: 'Move down' }))
    await waitFor(() => expect(api.reorderRunPromptQueue).toHaveBeenCalledWith('run-1', ['b', 'a']))
    expect((within(first!).getByRole('button', { name: 'Move up' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('rewords a typed prompt in place, and removes one', async () => {
    render(<PromptQueueDrawer run={run} notes={notes()} />)
    const [, second] = await open()
    fireEvent.click(within(second!).getByRole('button', { name: 'Edit' }))
    fireEvent.change(within(second!).getByRole('textbox', { name: 'Prompt text' }), { target: { value: 'reworded' } })
    fireEvent.click(within(second!).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(api.editQueuedRunPrompt).toHaveBeenCalledWith('run-1', 'b', 'reworded'))

    fireEvent.click(within(second!).getByRole('button', { name: 'Remove' }))
    await waitFor(() => expect(api.removeQueuedRunPrompt).toHaveBeenCalledWith('run-1', 'b'))
  })

  it('goes through the note when the prompt is a design note this window sent', async () => {
    const note: DesignNote = {
      key: 'k-1',
      pick: { url: '', selector: 'main > button.save', tag: 'button', text: '', html: '', styles: {}, rect: { x: 0, y: 0, width: 0, height: 0 }, viewport: { width: 0, height: 0 }, components: [], mark: 'k-1' },
      text: 'first follow-up',
      phase: 'queued',
      number: 1,
      queueId: 'a',
    }
    const hooks = notes({ notes: [note] })
    render(<PromptQueueDrawer run={run} notes={hooks} />)
    const [first] = await open()
    expect(within(first!).getByText('button.save')).toBeTruthy()
    fireEvent.click(within(first!).getByRole('button', { name: 'Remove' }))
    await waitFor(() => expect(hooks.withdraw).toHaveBeenCalledWith('k-1'))
    expect(api.removeQueuedRunPrompt).not.toHaveBeenCalled()
  })
})
