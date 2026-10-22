import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import { queryKeys } from '@/api/queries'
import type { RunArtifact, RunArtifactsResponse } from '@open-mercato/cezar-api-client'

import { ARTIFACT_IFRAME_SANDBOX, defaultArtifact } from './assets-model'
import { ASSETS_EMPTY_SUBTITLE, ASSETS_EMPTY_TITLE, AssetsView } from './assets-view'

const art = (name: string, kind: RunArtifact['kind'], updatedAt: string, title?: string): RunArtifact => ({
  name,
  kind,
  size: 100,
  updatedAt,
  ...(title ? { title } : {}),
})

const DEMO = art('demo.html', 'html', '2026-10-22T10:00:00.000Z', 'Dry-run demo')
const NOTES = art('notes.md', 'markdown', '2026-10-22T11:00:00.000Z', 'Notes')
const SHOT = art('shot.png', 'image', '2026-10-22T09:00:00.000Z')
const BLOB = art('data.bin', 'other', '2026-10-22T08:00:00.000Z')
const DATA = art('data.json', 'json', '2026-10-22T07:00:00.000Z')

let listing: RunArtifactsResponse

function stubFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input)
      if (path.endsWith('/runs/r1/artifacts')) {
        return new Response(JSON.stringify(listing), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (path.endsWith('/artifacts/notes.md')) return new Response('# Hello notes\n\nBody text.', { status: 200 })
      if (path.endsWith('/artifacts/data.json')) return new Response('{"a": 1}', { status: 200 })
      return new Response('not found', { status: 404 })
    }),
  )
}

function Where() {
  return <span data-testid="where">{useLocation().pathname}</span>
}

function mount(path = '/tasks/r1/assets', routed = true) {
  const client = createQueryClient()
  const view = render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/tasks/:id/assets/:name?" element={<><AssetsView runId="r1" routed={routed} /><Where /></>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return { ...view, client }
}

const frame = () => document.querySelector<HTMLIFrameElement>('[data-slot="assets-frame"]')

beforeEach(() => {
  localStorage.clear()
  listing = { artifacts: [SHOT, DEMO, NOTES], truncated: false }
  stubFetch()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  localStorage.clear()
})

describe('defaultArtifact', () => {
  it('prefers impact.html, then the newest HTML page, then the newest file', () => {
    const impact = art('impact.html', 'html', '2026-01-01T00:00:00.000Z')
    expect(defaultArtifact([DEMO, impact, NOTES])?.name).toBe('impact.html')
    expect(defaultArtifact([SHOT, DEMO, NOTES])?.name).toBe('demo.html')
    expect(defaultArtifact([SHOT, NOTES])?.name).toBe('notes.md')
    expect(defaultArtifact([])).toBeUndefined()
  })
})

describe('AssetsView', () => {
  it('frames HTML with exactly the sandbox tokens — never allow-same-origin — and the theme fragment', async () => {
    mount()
    await waitFor(() => expect(frame()).not.toBeNull())
    const iframe = frame()!
    const tokens = (iframe.getAttribute('sandbox') ?? '').split(/\s+/).sort()
    expect(tokens).toEqual(['allow-popups', 'allow-popups-to-escape-sandbox', 'allow-scripts'])
    expect(ARTIFACT_IFRAME_SANDBOX).not.toContain('allow-same-origin')
    expect(iframe.hasAttribute('srcdoc')).toBe(false)
    expect(iframe.getAttribute('referrerpolicy')).toBe('no-referrer')
    expect(iframe.getAttribute('title')).toBe('Dry-run demo')
    expect(iframe.getAttribute('src')).toMatch(/^\/api\/v1\/runs\/r1\/artifacts\/demo\.html#theme=(dark|light)$/)
    expect(screen.getByText('sandboxed')).toBeTruthy()
  })

  it('opens the asset the URL names, and the switcher writes the choice back into the URL', async () => {
    mount('/tasks/r1/assets/notes.md')
    await screen.findByText('Hello notes')
    expect(frame()).toBeNull()

    const trigger = screen.getByRole('button', { name: /switch asset/ })
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false })
    const item = await waitFor(() => {
      const found = document.querySelector('[data-asset="demo.html"]')
      if (!found) throw new Error('menu not open')
      return found as HTMLElement
    })
    fireEvent.click(item)

    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/tasks/r1/assets/demo.html'))
    await waitFor(() => expect(frame()).not.toBeNull())
  })

  it('keeps the selection local when the view shares its layout', async () => {
    mount('/tasks/r1/assets', false)
    await waitFor(() => expect(frame()).not.toBeNull())
    fireEvent.pointerDown(screen.getByRole('button', { name: /switch asset/ }), { button: 0, ctrlKey: false })
    const item = await waitFor(() => {
      const found = document.querySelector('[data-asset="notes.md"]')
      if (!found) throw new Error('menu not open')
      return found as HTMLElement
    })
    fireEvent.click(item)
    await screen.findByText('Hello notes')
    expect(screen.getByTestId('where').textContent).toBe('/tasks/r1/assets')
  })

  it('says so honestly when the run published nothing', async () => {
    listing = { artifacts: [], truncated: false }
    mount()
    expect(await screen.findByText(ASSETS_EMPTY_TITLE)).toBeTruthy()
    expect(screen.getByText(ASSETS_EMPTY_SUBTITLE)).toBeTruthy()
    expect(frame()).toBeNull()
  })

  it('renders an image inline, JSON as source and anything else as a download', async () => {
    listing = { artifacts: [SHOT, DATA, BLOB], truncated: false }
    const { unmount } = mount('/tasks/r1/assets/shot.png')
    const img = await waitFor(() => {
      const found = document.querySelector<HTMLImageElement>('[data-slot="assets-image"]')
      if (!found) throw new Error('no image')
      return found
    })
    expect(img.getAttribute('src')).toBe('/api/v1/runs/r1/artifacts/shot.png')
    unmount()

    const json = mount('/tasks/r1/assets/data.json')
    await waitFor(() => expect(document.querySelector('[data-slot="assets-json"]')?.textContent).toContain('"a"'))
    json.unmount()

    mount('/tasks/r1/assets/data.bin')
    expect(await screen.findByText('No preview for this file')).toBeTruthy()
    const download = document.querySelector('[data-action="assets-download-file"]')
    expect(download?.getAttribute('href')).toBe('/api/v1/runs/r1/artifacts/data.bin')
    expect(download?.getAttribute('download')).toBe('data.bin')
  })

  it('reloads the frame when the open asset is rewritten (a new listing from SSE)', async () => {
    const { client } = mount()
    await waitFor(() => expect(frame()).not.toBeNull())
    const before = frame()
    act(() => {
      client.setQueryData(queryKeys.runs.artifacts('r1'), {
        artifacts: [SHOT, { ...DEMO, updatedAt: '2026-10-22T12:00:00.000Z' }, NOTES],
        truncated: false,
      })
    })
    await waitFor(() => expect(frame()).not.toBe(before))
    expect(frame()).not.toBeNull()
  })

  it('Reload remounts the frame; Open and Download point at the raw URL', async () => {
    mount()
    await waitFor(() => expect(frame()).not.toBeNull())
    const before = frame()
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }))
    expect(frame()).not.toBe(before)
    const open = document.querySelector('[data-action="assets-open"]')
    expect(open?.getAttribute('href')).toBe('/api/v1/runs/r1/artifacts/demo.html')
    expect(open?.getAttribute('target')).toBe('_blank')
    expect(open?.getAttribute('rel')).toContain('noopener')
    expect(document.querySelector('[data-action="assets-download"]')?.getAttribute('download')).toBe('demo.html')
  })
})
