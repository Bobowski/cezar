import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { NewDesignPick } from '@/routes/task-thread/design-picks'

/**
 * The Code page's Browser with no task chosen (spec 2026-10-24-design-mode-third-cut §3.2): notes
 * collect as drafts, **Start task with N notes** opens `/new` pre-filled, and one note can still
 * be started alone.
 */

const api = vi.hoisted(() => ({
  getRepoDesignDrafts: vi.fn(),
  putRepoDesignDrafts: vi.fn(),
}))
vi.mock('@/api/client', () => api)

const navigate = vi.hoisted(() => vi.fn())
vi.mock('@/lib/project-router', () => ({ useNavigate: () => navigate }))
vi.mock('@/api/project-scope-context', () => ({ useProjectScope: () => ({ projectId: null }) }))
vi.mock('@/routes/task-workspace/source-roots', () => ({ useSourceRoots: () => [] }))
vi.mock('@/components/ui/toaster', () => ({ toast: vi.fn() }))

/** A stand-in Browser column: what the host hands it is what is under test here. */
const view = vi.hoisted(() => ({ props: null as null | Record<string, unknown> }))
vi.mock('@/routes/task-workspace/browser-view', () => ({
  BrowserView: (props: Record<string, unknown>) => {
    view.props = props
    const render = props.renderDesignNote as (c: { mark: string; close: () => void }) => React.ReactNode
    return (
      <div>
        {props.designToolbar as React.ReactNode}
        {['k-1', 'k-2'].map((mark) => <div key={mark} data-testid={`note-${mark}`}>{render({ mark, close: () => {} })}</div>)}
      </div>
    )
  },
}))

import { readDraft } from '@/routes/new-task-draft'

import { CodeBrowserTab } from './code-browser'
import { resetProjectDesignDrafts, takePendingDesignStart } from './project-design-drafts'

const pick = (mark: string, selector: string): NewDesignPick => ({
  url: 'http://localhost:5173/',
  selector,
  tag: 'button',
  text: '',
  html: '<button></button>',
  styles: {},
  rect: { x: 0, y: 0, width: 1, height: 1 },
  viewport: { width: 1, height: 1 },
  components: [],
  source: { file: 'src/a.tsx', line: 3 },
  mark,
})

const renderTab = (onStartTask = vi.fn(async () => {})) => {
  render(<CodeBrowserTab state={{ tabs: [], active: 0 } as never} onChange={vi.fn()} run={null} onStartTask={onStartTask} />)
  return { onStartTask }
}

const pickElement = (element: NewDesignPick) => act(() => { (view.props!.onPickElement as (p: NewDesignPick) => boolean)(element) })

beforeEach(() => {
  resetProjectDesignDrafts()
  navigate.mockReset()
  api.getRepoDesignDrafts.mockReset().mockResolvedValue({ picks: [] })
  api.putRepoDesignDrafts.mockReset().mockResolvedValue({ picks: [] })
})
afterEach(cleanup)

describe('notes with no task chosen', () => {
  it('collect as drafts, written through to the project, instead of starting a task each', async () => {
    const { onStartTask } = renderTab()
    await waitFor(() => expect(api.getRepoDesignDrafts).toHaveBeenCalled())
    await act(async () => {})
    pickElement(pick('k-1', 'main > button.one'))
    pickElement(pick('k-2', 'main > button.two'))

    expect(await screen.findByRole('button', { name: 'Start task with 2 notes' })).toBeTruthy()
    await waitFor(() => expect(api.putRepoDesignDrafts).toHaveBeenCalled())
    const written = api.putRepoDesignDrafts.mock.calls.at(-1)![0] as { picks: Array<{ mark: string; note: string; source?: unknown }> }
    expect(written.picks.map((each) => each.mark)).toEqual(['k-1', 'k-2'])
    expect(written.picks[0]!.source).toEqual({ file: 'src/a.tsx', line: 3 })
    expect(onStartTask).not.toHaveBeenCalled()
  })

  it('Start task with N notes opens /new pre-filled with the notes in order', async () => {
    api.getRepoDesignDrafts.mockResolvedValue({
      picks: [
        { ...pick('k-1', 'main > button.one'), note: 'bigger' },
        { ...pick('k-2', 'main > button.two'), note: 'red' },
      ],
    })
    renderTab()
    fireEvent.click(await screen.findByRole('button', { name: 'Start task with 2 notes' }))

    expect(navigate).toHaveBeenCalledWith('/new?design=1')
    const text = readDraft(null).text
    expect(text.indexOf('1. bigger')).toBeGreaterThan(-1)
    expect(text.indexOf('2. red')).toBeGreaterThan(text.indexOf('1. bigger'))
    expect(text).toContain('source: src/a.tsx:3')
    // Starting the task there consumes exactly these.
    expect(takePendingDesignStart(null)).toEqual(['k-1', 'k-2'])
  })

  it('starts one note alone from its menu, and numbers its frame', async () => {
    api.getRepoDesignDrafts.mockResolvedValue({ picks: [{ ...pick('k-1', 'main > button.one'), note: 'bigger' }] })
    const { onStartTask } = renderTab()
    fireEvent.click(await screen.findByRole('button', { name: 'Start task with this note' }))
    await waitFor(() => expect(onStartTask).toHaveBeenCalledTimes(1))
    expect((onStartTask.mock.calls[0] as unknown as [string])[0].startsWith('bigger\n\n')).toBe(true)
    await waitFor(() => expect(view.props!.designMarks).toEqual([{ key: 'k-1', n: 1, label: 'button.one', draft: false }]))
    expect(screen.queryByRole('button', { name: /Start task with \d+ note/ })).toBeNull()
  })
})
