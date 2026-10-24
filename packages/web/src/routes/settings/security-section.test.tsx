import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { authQueryKeys } from '@/api/auth'
import { createQueryClient } from '@/api/query-client'
import { visibleSettingsSections } from './registry'
import { lastActive, SecuritySection } from './security-section'

const USER = { id: 'u1', name: 'mateusz', role: 'owner' as const }
const DEVICES = [
  { id: 's1', label: 'Chrome on macOS', createdAt: '2026-10-12T10:00:00.000Z', lastSeenAt: '2026-10-12T12:00:00.000Z', expiresAt: '2026-10-19T12:00:00.000Z', current: true },
  { id: 's2', label: 'Safari on iPhone', createdAt: '2026-10-11T10:00:00.000Z', lastSeenAt: '2026-10-12T09:00:00.000Z', expiresAt: '2026-10-18T09:00:00.000Z', current: false },
]

const TOKENS = [
  { id: '0123456789ab', name: 'Claude Code', scopes: ['tasks', 'read'], createdAt: '2026-10-20T10:00:00.000Z', lastUsedAt: '2026-10-24T09:00:00.000Z' },
]

let requests: Array<{ method: string; url: string; body?: unknown }> = []
const json = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })

function serve(overrides: Record<string, () => Response> = {}) {
  requests = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      requests.push({ method, url, body: init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined })
      const answer = overrides[`${method} ${url}`]
      if (answer) return answer()
      if (url === '/api/v1/auth/sessions') return json({ sessions: DEVICES })
      if (url === '/api/v1/auth/tokens' && method === 'GET') return json({ tokens: TOKENS })
      return json({ ok: true })
    }),
  )
}

function renderSection(signedIn = true) {
  const client = createQueryClient()
  // The gate owns this answer in the app; the section only ever reads it from the cache.
  client.setQueryData(
    authQueryKeys.session,
    signedIn
      ? { enforced: true, authenticated: true, setupRequired: false, user: USER }
      : { enforced: false, authenticated: true, setupRequired: false },
  )
  render(
    <QueryClientProvider client={client}>
      <SecuritySection />
    </QueryClientProvider>,
  )
}

// jsdom has no layout, and the one-time-code field asks where its caret is.
document.elementFromPoint ??= () => null

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('Settings → Security', () => {
  it('is listed only on a cockpit someone is signed in to', () => {
    expect(visibleSettingsSections('global').map((s) => s.id)).not.toContain('security')
    expect(visibleSettingsSections('global', undefined, { signedIn: false }).map((s) => s.id)).not.toContain('security')
    expect(visibleSettingsSections('global', undefined, { signedIn: true }).map((s) => s.id)).toContain('security')
    expect(visibleSettingsSections('project', undefined, { signedIn: true }).map((s) => s.id)).not.toContain('security')
  })

  it('says so, and asks the server nothing, when there is no sign-in', () => {
    serve()
    renderSection(false)
    expect(screen.getByText(/Sign-in is not enabled/)).toBeTruthy()
    expect(requests).toEqual([])
  })

  it('lists the devices and marks the one in hand', async () => {
    serve()
    renderSection()
    expect(await screen.findByText('Safari on iPhone')).toBeTruthy()
    expect(screen.getByText('This device')).toBeTruthy()
    expect(screen.getByText('mateusz')).toBeTruthy()
  })

  it('signs another device out by id and re-reads the list', async () => {
    serve()
    renderSection()
    await screen.findByText('Safari on iPhone')
    const row = screen.getByText('Safari on iPhone').closest('li')!
    fireEvent.click(row.querySelector('button')!)
    await waitFor(() => expect(requests.some((r) => r.method === 'DELETE' && r.url === '/api/v1/auth/sessions/s2')).toBe(true))
    await waitFor(() => expect(requests.filter((r) => r.url === '/api/v1/auth/sessions' && r.method === 'GET').length).toBe(2))
  })

  it('offers "sign out other devices" only when there are others', async () => {
    serve({ 'GET /api/v1/auth/sessions': () => json({ sessions: [DEVICES[0]] }) })
    renderSection()
    await screen.findByText('Chrome on macOS')
    expect(screen.queryByRole('button', { name: 'Sign out other devices' })).toBeNull()
  })

  it('keeps Change password disabled until both passwords and a 6-digit code are there', async () => {
    serve()
    renderSection()
    const button = screen.getByRole('button', { name: 'Change password' }) as HTMLButtonElement
    fireEvent.change(screen.getByLabelText('Current password'), { target: { value: 'the old password!' } })
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'short' } })
    expect(screen.getByText('At least 12 characters.')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'a brand new password' } })
    fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: 'a brand new passwork' } })
    expect(screen.getByText('The two passwords do not match.')).toBeTruthy()
    expect(button.disabled).toBe(true)
  })

  it('lists the API tokens with their scopes, and revokes one by id', async () => {
    serve()
    renderSection()
    expect(await screen.findByText('Claude Code')).toBeTruthy()
    const row = screen.getByText('Claude Code').closest('li')!
    expect(within(row).getByText('tasks')).toBeTruthy()
    fireEvent.click(within(row).getByRole('button', { name: 'Revoke' }))
    await waitFor(() => expect(requests.some((r) => r.method === 'DELETE' && r.url === '/api/v1/auth/tokens/0123456789ab')).toBe(true))
  })

  it('mints a token with the chosen scopes and a fresh code, and shows its value once', async () => {
    serve({
      'POST /api/v1/auth/tokens': () =>
        json({ token: { ...TOKENS[0], id: 'ffffffffffff', name: 'laptop', scopes: ['tasks', 'author'] }, value: 'ceztok_ffffffffffff_secretvalue' }, 201),
    })
    // Radix's checkbox measures itself; jsdom never resizes anything.
    vi.stubGlobal('ResizeObserver', class { observe() {}; unobserve() {}; disconnect() {} })
    renderSection()
    await screen.findByText('Claude Code')
    fireEvent.click(screen.getByRole('button', { name: 'New token' }))
    const dialog = await screen.findByRole('dialog')
    const create = within(dialog).getByRole('button', { name: 'Create token' }) as HTMLButtonElement
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'laptop' } })
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /Author/ }))
    expect(create.disabled).toBe(true) // no code yet
    fireEvent.change(within(dialog).getByLabelText('Authenticator code'), { target: { value: '123456' } })
    fireEvent.click(create)
    expect(await within(dialog).findByText('ceztok_ffffffffffff_secretvalue')).toBeTruthy()
    const sent = requests.find((r) => r.method === 'POST' && r.url === '/api/v1/auth/tokens')?.body as Record<string, unknown>
    expect(sent).toMatchObject({ name: 'laptop', scopes: ['tasks', 'author'], code: '123456' })
    expect(typeof sent.expiresAt).toBe('string')
  })

  it('describes last activity coarsely', () => {
    const now = Date.parse('2026-10-12T12:00:00.000Z')
    expect(lastActive('2026-10-12T11:59:40.000Z', now)).toBe('just now')
    expect(lastActive('2026-10-12T11:30:00.000Z', now)).toBe('30 minutes ago')
    expect(lastActive('2026-10-12T09:00:00.000Z', now)).toBe('3 hours ago')
    expect(lastActive('2026-10-11T12:00:00.000Z', now)).toBe('yesterday')
  })
})
