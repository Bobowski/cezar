import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import { FirstRun } from '@/components/first-run'

/**
 * Which first-run page shows (spec 2026-10-26-first-run-onboarding). The rule this pins down is
 * "nothing until known": a page that flips to another one a moment later is worse than a short
 * blank, for the agent answer and for the git answer alike.
 */

vi.mock('@/api/global-events', () => ({ onWorkspaceEvent: () => () => undefined }))
vi.mock('@/components/ui/toaster', () => ({ toast: vi.fn() }))

const fetchMock = vi.fn<typeof fetch>()
let singleProject = false

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockImplementation(async (input) => {
    const url = new URL(String(input), 'http://localhost')
    const body =
      url.pathname === '/api/v1/providers/status'
        ? { providers: [{ provider: 'claude', status: 'connected' }] }
        : url.pathname === '/api/v1/workspace/ui-state'
          ? { onboarding: { agentCheckSkipped: true } }
          : url.pathname === '/api/v1/fs/repos'
            ? { repos: [], truncated: false }
            : url.pathname === '/api/v1/projects/github-owners'
              ? { available: false, reason: 'gh is not authenticated' }
              : url.pathname === '/api/v1/health'
                ? { repoRoot: '/work/plans', capabilities: { singleProject } }
                : { error: 'not stubbed' }
    return new Response(JSON.stringify(body), { status: 'error' in body ? 404 : 200, headers: { 'content-type': 'application/json' } })
  })
})

afterEach(() => {
  singleProject = false
  cleanup()
  fetchMock.mockReset()
  vi.unstubAllGlobals()
})

function renderFirstRun(gitRepo: boolean | undefined) {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter>
        <FirstRun gitRepo={gitRepo} />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const page = () => document.querySelector('[data-slot="first-run"]')?.getAttribute('data-first-run')

describe('FirstRun', () => {
  it('shows nothing while the git answer is unknown, even past the agent step', async () => {
    renderFirstRun(undefined)
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    await new Promise((resolveSoon) => setTimeout(resolveSoon, 50))
    expect(page()).toBeUndefined()
  })

  it('a plain folder gets the pick-a-project step', async () => {
    renderFirstRun(false)
    await waitFor(() => expect(page()).toBe('pick-project'))
    expect(screen.getByRole('button', { name: 'Initialize git here' })).toBeTruthy()
  })

  it('offers no git init in a single-project workspace, where the server refuses it', async () => {
    singleProject = true
    renderFirstRun(false)
    await waitFor(() => expect(page()).toBe('pick-project'))
    await waitFor(() => expect(screen.getByText('isn’t a git repository.', { exact: false })).toBeTruthy())
    await new Promise((resolveSoon) => setTimeout(resolveSoon, 50))
    expect(screen.queryByRole('button', { name: 'Initialize git here' })).toBeNull()
  })
})
