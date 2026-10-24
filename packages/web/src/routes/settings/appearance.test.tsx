import { QueryClientProvider, type QueryClient } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import { authQueryKeys } from '@/api/auth'
import { queryKeys, workspaceQueryKeys } from '@/api/queries'
import { AppearanceProvider } from '@/components/appearance-provider'
import { ThemeProvider } from '@/components/theme-provider'
import { AppearanceSection } from './appearance'

/**
 * Settings → Appearance's project-order reset (#952). The order itself is set by dragging the
 * drawer; this section owns the undo, and the rule worth pinning is that the undo is ABSENT
 * whenever it could only do nothing — a reset button for state the user has never created is a
 * dead control, and the sidebar's own emptiness is not something Settings should announce.
 */

const RESET = '[data-slot="appearance-project-order-reset"]'

let requests: Array<{ method: string; url: string; body?: unknown }> = []

const BRAND = { name: 'cezar', logoUrl: null, faviconUrl: null as string | null, appIconUrl: null, accent: null as string | null, accentTokens: null, custom: false }
let brand = BRAND

function serve(uiState: Record<string, unknown> = {}) {
  requests = []
  brand = BRAND
  let workspaceConfig = {
    branding: { name: 'cezar', logoUrl: null as string | null },
    browseRoot: '~/', projectsDir: '~/cezar/projects', skillsAutoUpdate: null, effectiveSkillsAutoUpdate: true,
    composerDefaults: { autonomous: null, worktree: null, inheritedAutonomous: 'source-dependent', inheritedWorktree: true },
    resources: { maxParallel: 2, maxMonitoringSessions: 2, idleTimeoutMinutes: 15, monitoringWakeIntervalMinutes: 5, autoResumeOnUsageLimit: true, memoryLimitMb: null, worktreeRetentionDefault: 10 },
    agentDefaults: {},
  }
  const json = (payload: unknown) =>
    new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : init?.body
      requests.push({ method, url, body })
      if (url === '/api/v1/workspace/ui-state' && method === 'GET') return json(uiState)
      if (url === '/api/v1/workspace/ui-state' && method === 'PUT')
        return json({ ...uiState, ...(body as Record<string, unknown>) })
      if (url === '/api/v1/workspace/config' && method === 'GET') return json(workspaceConfig)
      if (url === '/api/v1/workspace/config' && method === 'PUT') {
        const patch = body as { branding?: Partial<typeof workspaceConfig.branding> }
        workspaceConfig = { ...workspaceConfig, branding: { ...workspaceConfig.branding, ...patch.branding } }
        return json(workspaceConfig)
      }
      if (url === '/api/v1/workspace/branding-logo' && method === 'POST') return json({ logoUrl: '/api/v1/workspace/branding-logo?v=abc123' })
      if (url === '/api/v1/workspace/branding-logo' && method === 'DELETE') return json({ logoUrl: null })
      if (url === '/api/v1/workspace/branding' && method === 'GET') return json(brand)
      if (url === '/api/v1/workspace/branding' && method === 'PUT') {
        const patch = body as { accent?: string | null }
        brand = { ...brand, accent: patch.accent ?? null, custom: patch.accent != null }
        return json(brand)
      }
      if (url === '/api/v1/workspace/branding' && method === 'DELETE') return json((brand = BRAND))
      if (url === '/api/v1/workspace/branding/favicon' && method === 'PUT') {
        return json((brand = { ...brand, faviconUrl: '/api/v1/workspace/branding/favicon?v=aaaaaaaaaaaa', custom: true }))
      }
      return new Promise<never>(() => {})
    }),
  )
}

/** The registry is seeded rather than fetched: this section only asks it "more than one?". */
function seedProjects(client: QueryClient, ids: string[]) {
  client.setQueryData(workspaceQueryKeys.projects, {
    projects: ids.map((id) => ({
      id,
      name: id,
      root: `/home/me/${id}`,
      addedAt: '2026-07-01T00:00:00.000Z',
      lastOpenedAt: '2026-07-20T00:00:00.000Z',
      source: 'local',
      status: 'ok',
    })),
    bootProject: ids[0] ?? 'cezar',
    projectsDir: '~/cezar/projects',
  })
}

function renderSection(projectIds: string[], seed?: (client: QueryClient) => void) {
  const client = createQueryClient()
  seedProjects(client, projectIds)
  seed?.(client)
  render(
    <QueryClientProvider client={client}>
      <ThemeProvider>
        <AppearanceProvider>
          <AppearanceSection />
        </AppearanceProvider>
      </ThemeProvider>
    </QueryClientProvider>,
  )
}

beforeEach(() => serve())

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  localStorage.clear()
})

describe('Settings → Appearance: branding writes', () => {
  const hosted = (session: { enforced: boolean; user?: { id: string } }) => (client: QueryClient) => {
    client.setQueryData(queryKeys.health, { capabilities: { localHandoff: false } })
    client.setQueryData(authQueryKeys.session, { authenticated: session.enforced, setupRequired: false, ...session })
  }

  it('offers no branding control on a hosted cockpit without sign-in, which refuses every write', async () => {
    renderSection(['cezar'], hosted({ enforced: false }))
    expect((await screen.findByText(/Sign-in required/)).closest('[data-slot="branding-readonly"]')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Choose logo' })).toBeNull()
    expect(screen.queryByLabelText('Instance name')).toBeNull()
    expect(screen.queryByLabelText('Upload favicon')).toBeNull()
    expect(document.querySelector('[data-slot="branding-reset"]')).toBeNull()
  })

  it('offers them to the signed-in owner of a hosted cockpit', () => {
    renderSection(['cezar'], hosted({ enforced: true, user: { id: 'owner' } }))
    expect(screen.getByRole('button', { name: 'Choose logo' })).toBeTruthy()
    expect(document.querySelector('[data-slot="branding-readonly"]')).toBeNull()
  })
})

describe('Settings → Appearance: project order', () => {
  it('previews a selected logo and uploads only after Save logo', async () => {
    serve()
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:logo-preview', revokeObjectURL: vi.fn() }))
    renderSection(['cezar'])
    const file = new File(['sample-image'], 'brand.png', { type: 'image/png' })
    expect(screen.getByRole('button', { name: 'Choose logo' })).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Upload logo'), { target: { files: [file] } })
    expect(await screen.findByAltText('Logo preview')).toBeTruthy()
    expect(screen.getByText('brand.png')).toBeTruthy()
    expect(requests.some((request) => request.url === '/api/v1/workspace/branding-logo' && request.method === 'POST')).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Save logo' }))
    await waitFor(() => expect(requests.some((request) => request.url === '/api/v1/workspace/branding-logo' && request.method === 'POST')).toBe(true))
  })

  it('uploads a favicon as soon as it is chosen, applies an accent, and resets the whole brand', async () => {
    renderSection(['cezar'])
    const reset = () => document.querySelector<HTMLButtonElement>('[data-slot="branding-reset"]')!
    await waitFor(() => expect(requests.some((request) => request.url === '/api/v1/workspace/branding')).toBe(true))
    expect(reset().disabled).toBe(true) // nothing to reset yet
    const svg = new File(['<svg xmlns="http://www.w3.org/2000/svg"/>'], 'favicon.svg', { type: 'image/svg+xml' })
    fireEvent.change(screen.getByLabelText('Upload favicon'), { target: { files: [svg] } })
    expect(await screen.findByAltText('Current favicon')).toBeTruthy()
    const upload = requests.find((request) => request.url === '/api/v1/workspace/branding/favicon')!
    expect(upload.method).toBe('PUT')
    expect(atob((upload.body as { data: string }).data)).toBe('<svg xmlns="http://www.w3.org/2000/svg"/>')

    fireEvent.change(screen.getByLabelText('Accent colour'), { target: { value: '#7C3AED' } })
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    await waitFor(() => expect(requests.some((request) => request.method === 'PUT' && request.url === '/api/v1/workspace/branding')).toBe(true))
    expect(requests.find((request) => request.method === 'PUT' && request.url === '/api/v1/workspace/branding')!.body).toEqual({ accent: '#7c3aed' })
    // The default accent option now names the brand's colour.
    expect(await screen.findByText('Brand')).toBeTruthy()

    await waitFor(() => expect(reset().disabled).toBe(false))
    fireEvent.click(reset())
    await waitFor(() => expect(requests.some((request) => request.method === 'DELETE' && request.url === '/api/v1/workspace/branding')).toBe(true))
    await waitFor(() => expect(screen.queryByAltText('Current favicon')).toBeNull())
  })

  it('offers the reset once an order has been stored', async () => {
    serve({ sidebar: { collapsed: { cezar: true }, projectOrder: ['shop', 'cezar'] } })
    renderSection(['cezar', 'shop'])

    await waitFor(() => expect(document.querySelector(RESET)).not.toBeNull())
    fireEvent.click(screen.getByRole('button', { name: 'Reset order' }))

    // Forgetting the order is the key going away — not an empty list, which would read as "the
    // user placed nothing on purpose" — and the legacy collapse map rides along untouched.
    await waitFor(() => expect(requests.filter((r) => r.method === 'PUT')).toHaveLength(1))
    expect(requests.find((r) => r.method === 'PUT')?.body).toEqual({
      sidebar: { collapsed: { cezar: true } },
    })
  })

  it('stays absent when nothing has been reordered', async () => {
    serve({ appearance: { accent: 'violet' } })
    renderSection(['cezar', 'shop'])

    await waitFor(() => expect(screen.getByText('Reading width')).not.toBeNull())
    expect(document.querySelector(RESET)).toBeNull()
  })

  it('stays absent in a single-project workspace, order or no order', async () => {
    // The grouped sidebar does not render below two projects, so there is no order to undo.
    serve({ sidebar: { projectOrder: ['cezar'] } })
    renderSection(['cezar'])

    await waitFor(() => expect(screen.getByText('Reading width')).not.toBeNull())
    expect(document.querySelector(RESET)).toBeNull()
  })
})
