import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { getHealth } from '@/api/client'
import { createQueryClient } from '@/api/query-client'
import { AuthGate } from './auth-gate'
import { setupCodeFromLocation } from './setup-screen'

/**
 * The gate (spec 2026-10-12-cockpit-authentication §8): nothing below it mounts until the session
 * answer allows it, a local cockpit never sees a screen, and a 401 mid-session re-asks.
 */

type Session = { enforced: boolean; authenticated: boolean; setupRequired: boolean; user?: { id: string; name: string; role: 'owner' } }

let session: Session | 'unreachable'
let requests: Array<{ method: string; url: string; body?: unknown }> = []
let answers: Record<string, () => Response> = {}

const json = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })

function serve(initial: Session | 'unreachable') {
  session = initial
  requests = []
  answers = {}
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      requests.push({ method, url, body: init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined })
      if (url === '/api/v1/auth/session') {
        if (session === 'unreachable') throw new TypeError('network down')
        return json(session)
      }
      const answer = answers[`${method} ${url}`]
      if (answer) return answer()
      return json({ error: 'authentication required' }, 401)
    }),
  )
}

function renderGate() {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <AuthGate>
        <div data-testid="cockpit">cockpit</div>
      </AuthGate>
    </QueryClientProvider>,
  )
}

const SIGNED_OUT: Session = { enforced: true, authenticated: false, setupRequired: false }
const SIGNED_IN: Session = { enforced: true, authenticated: true, setupRequired: false, user: { id: 'u1', name: 'mateusz', role: 'owner' } }

// jsdom has no layout, and the one-time-code field asks where its caret is.
document.elementFromPoint ??= () => null

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  window.history.replaceState(null, '', '/')
})

describe('AuthGate', () => {
  it('a local cockpit goes straight through: one request, no screen', async () => {
    serve({ enforced: false, authenticated: true, setupRequired: false })
    renderGate()
    expect(await screen.findByTestId('cockpit')).toBeTruthy()
    expect(requests).toEqual([{ method: 'GET', url: '/api/v1/auth/session', body: undefined }])
  })

  it('mounts NOTHING of the cockpit while signed out', async () => {
    serve(SIGNED_OUT)
    renderGate()
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeTruthy()
    expect(screen.queryByTestId('cockpit')).toBeNull()
  })

  it('an unreachable or pre-auth server is not a login wall — the cockpit shows its own error states', async () => {
    serve('unreachable')
    renderGate()
    expect(await screen.findByTestId('cockpit')).toBeTruthy()
  })

  it('shows setup when no account exists, and says where the link comes from', async () => {
    serve({ enforced: true, authenticated: false, setupRequired: true })
    renderGate()
    expect(await screen.findByRole('heading', { name: 'Set up this cockpit' })).toBeTruthy()
    expect(screen.getByText('cezar auth setup')).toBeTruthy()
    expect(screen.getByLabelText('Setup code')).toBeTruthy()
  })

  it('reads the one-time code from the link fragment and does not ask for it again', async () => {
    window.history.replaceState(null, '', '/setup#code=abc123')
    expect(setupCodeFromLocation()).toBe('abc123')
    serve({ enforced: true, authenticated: false, setupRequired: true })
    renderGate()
    await screen.findByRole('heading', { name: 'Set up this cockpit' })
    expect(screen.queryByLabelText('Setup code')).toBeNull()
  })

  it('signs in with the password, then the code — and only then opens the cockpit', async () => {
    serve(SIGNED_OUT)
    answers['POST /api/v1/auth/login'] = () => json({ ticket: 't1' })
    answers['POST /api/v1/auth/login/verify'] = () => {
      session = SIGNED_IN
      return json({ user: SIGNED_IN.user })
    }
    renderGate()
    fireEvent.change(await screen.findByLabelText('Username'), { target: { value: ' mateusz ' } })
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'a long enough password' } })
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(await screen.findByRole('heading', { name: 'Two-step verification' })).toBeTruthy()
    expect(screen.queryByTestId('cockpit')).toBeNull()
    expect(requests.at(-1)).toEqual({
      method: 'POST', url: '/api/v1/auth/login', body: { username: 'mateusz', password: 'a long enough password' },
    })

    fireEvent.click(screen.getByRole('button', { name: 'Use a recovery code' }))
    fireEvent.change(screen.getByLabelText('Recovery code'), { target: { value: 'abcde-fghjk' } })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(await screen.findByTestId('cockpit')).toBeTruthy()
    expect(requests.find((request) => request.url.endsWith('/login/verify'))?.body).toEqual({ ticket: 't1', code: 'abcde-fghjk' })
  })

  it('shows the server’s own words when it refuses, as a sentence', async () => {
    serve(SIGNED_OUT)
    answers['POST /api/v1/auth/login'] = () => json({ error: 'wrong username or password' }, 401)
    renderGate()
    fireEvent.change(await screen.findByLabelText('Username'), { target: { value: 'mateusz' } })
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'nope nope nope' } })
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect((await screen.findByRole('alert')).textContent).toBe('Wrong username or password')
    // A refused sign-in is not "the session ended": it must not bounce the gate.
    expect(requests.filter((request) => request.url === '/api/v1/auth/session')).toHaveLength(1)
  })

  it('a 401 in the middle of a session re-asks, and the sign-in screen replaces the cockpit', async () => {
    serve(SIGNED_IN)
    renderGate()
    await screen.findByTestId('cockpit')
    session = SIGNED_OUT
    await act(async () => {
      await getHealth().catch(() => undefined)
    })
    await waitFor(() => expect(screen.queryByTestId('cockpit')).toBeNull())
    expect(screen.getByRole('heading', { name: 'Sign in' })).toBeTruthy()
  })
})
