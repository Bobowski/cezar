import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { useSignedInUser } from '@/api/auth'
import { getHealth } from '@/api/client'
import { createQueryClient } from '@/api/query-client'
import { AuthGate } from './auth-gate'
import { setupCodeFromLocation } from './setup-screen'

/**
 * The gate (spec 2026-10-12-cockpit-authentication §8): nothing below it mounts until the session
 * answer allows it, a local cockpit never sees a screen, and a 401 mid-session re-asks.
 */

type Session = { enforced: boolean; authenticated: boolean; setupRequired: boolean; user?: { id: string; name: string; role: 'owner' } }

type Down = 'unreachable' | 'bad-gateway'
let session: Session | Down
let requests: Array<{ method: string; url: string; body?: unknown }> = []
let answers: Record<string, () => Response | Promise<Response>> = {}

const json = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })

const CEZAR_BRAND = { name: 'cezar', logoUrl: null, faviconUrl: null, appIconUrl: null, accent: null, accentTokens: null, custom: false }
let brand: Record<string, unknown> = CEZAR_BRAND

function serve(initial: Session | Down) {
  session = initial
  requests = []
  answers = {}
  brand = CEZAR_BRAND
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      requests.push({ method, url, body: init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined })
      if (url === '/api/v1/auth/session') {
        if (session === 'unreachable') throw new TypeError('network down')
        if (session === 'bad-gateway') return new Response('<html>502</html>', { status: 502, headers: { 'content-type': 'text/html' } })
        return json(session)
      }
      const answer = answers[`${method} ${url}`]
      if (answer) return answer()
      // Public, like the sign-in page that shows it (spec 2026-10-24-cockpit-branding §5).
      if (url === '/api/v1/workspace/branding') return json(brand)
      return json({ error: 'authentication required' }, 401)
    }),
  )
}

function Cockpit() {
  return <div data-testid="cockpit">cockpit {useSignedInUser()?.name ?? 'nobody'}</div>
}

function renderGate() {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <AuthGate>
        <Cockpit />
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

  const sessionAsks = () => requests.filter((request) => request.url === '/api/v1/auth/session').length

  it('a session question that FAILED is asked again — a restart behind the proxy must not cost Sign out', async () => {
    serve('bad-gateway')
    renderGate()
    expect((await screen.findByTestId('cockpit')).textContent).toBe('cockpit nobody')
    session = SIGNED_IN
    await waitFor(() => expect(screen.getByTestId('cockpit').textContent).toBe('cockpit mateusz'), { timeout: 5000 })
    // Answered: nothing keeps asking.
    const asked = sessionAsks()
    await new Promise((resolve) => setTimeout(resolve, 1500))
    expect(sessionAsks()).toBe(asked)
  })

  it('…and again when the tab comes back, without waiting for the timer', async () => {
    serve('unreachable')
    renderGate()
    await screen.findByTestId('cockpit')
    session = SIGNED_OUT
    act(() => void window.dispatchEvent(new Event('visibilitychange')))
    expect(await screen.findByRole('heading', { name: 'Sign in' }, { timeout: 500 })).toBeTruthy()
  })

  it('a server that stays down is not polled forever, and never blocks the cockpit', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      serve('unreachable')
      renderGate()
      expect(await screen.findByTestId('cockpit')).toBeTruthy()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30 * 60_000)
      })
      const asked = sessionAsks()
      expect(asked).toBeGreaterThan(2)
      expect(asked).toBeLessThan(12)
      expect(screen.getByTestId('cockpit')).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })

  it('a local cockpit that answered is never asked again, tab focus included', async () => {
    serve({ enforced: false, authenticated: true, setupRequired: false })
    renderGate()
    await screen.findByTestId('cockpit')
    act(() => void window.dispatchEvent(new Event('visibilitychange')))
    await new Promise((resolve) => setTimeout(resolve, 1200))
    expect(sessionAsks()).toBe(1)
  })

  it('a dead enrolment ticket leads back to step one, where the same link still works', async () => {
    window.history.replaceState(null, '', '/setup#code=abc123')
    serve({ enforced: true, authenticated: false, setupRequired: true })
    let begun = 0
    answers['POST /api/v1/auth/setup/begin'] = () => {
      begun += 1
      return json({ ticket: `t${begun}`, secret: 'JBSWY3DPEHPK3PXP', otpauthUri: 'otpauth://totp/cezar:mateusz?secret=JBSWY3DPEHPK3PXP' })
    }
    // What the server says once the ticket is burned or timed out (auth/service.ts completeSetup).
    answers['POST /api/v1/auth/setup/complete'] = () => json({ error: 'setup expired — start again' }, 401)
    renderGate()
    fireEvent.change(await screen.findByLabelText('Username'), { target: { value: 'mateusz' } })
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'a long enough password' } })
    fireEvent.change(screen.getByLabelText('Confirm password'), { target: { value: 'a long enough password' } })
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await screen.findByRole('heading', { name: 'Add your authenticator' })
    fireEvent.change(screen.getByLabelText('Authenticator code'), { target: { value: '123456' } })

    expect(await screen.findByRole('heading', { name: 'Set up this cockpit' })).toBeTruthy()
    const alert = screen.getByRole('alert').textContent ?? ''
    expect(alert).toContain('Setup expired')
    // The setup code is spent at COMPLETE, so it is still good: no new `cezar auth setup` is asked for.
    expect(alert).not.toContain('cezar auth setup')
    expect(screen.queryByLabelText('Setup code')).toBeNull()
    // Nothing to retype: one press gets a fresh ticket and a fresh QR.
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await screen.findByRole('heading', { name: 'Add your authenticator' })
    expect(requests.filter((request) => request.url.endsWith('/setup/begin')).map((request) => request.body)).toEqual([
      { code: 'abc123', username: 'mateusz', password: 'a long enough password' },
      { code: 'abc123', username: 'mateusz', password: 'a long enough password' },
    ])
    // And the step has its own way back, for a QR that was scanned into the wrong account.
    fireEvent.click(screen.getByRole('button', { name: 'Start over' }))
    expect(await screen.findByRole('heading', { name: 'Set up this cockpit' })).toBeTruthy()
  })

  it('a rejected code leaves the cursor in an empty code field', async () => {
    serve(SIGNED_OUT)
    answers['POST /api/v1/auth/login'] = () => json({ ticket: 't1' })
    let reject: (response: Response) => void = () => undefined
    answers['POST /api/v1/auth/login/verify'] = () => new Promise<Response>((resolve) => (reject = resolve))
    renderGate()
    fireEvent.change(await screen.findByLabelText('Username'), { target: { value: 'mateusz' } })
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'a long enough password' } })
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    const field = (await screen.findByLabelText('Authenticator code')) as HTMLInputElement
    expect(document.activeElement).toBe(field)
    fireEvent.change(field, { target: { value: '000000' } })
    await waitFor(() => expect(field.disabled).toBe(true))
    // What a browser does to a focused control that gets disabled: focus falls to the body.
    // jsdom leaves it where it was (and will not blur a disabled input), so take it away by hand.
    const elsewhere = document.body.appendChild(document.createElement('button'))
    elsewhere.focus()
    elsewhere.remove()
    expect(document.activeElement).toBe(document.body)
    await act(async () => reject(json({ error: 'that code is not valid' }, 401)))
    expect((await screen.findByRole('alert')).textContent).toBe('That code is not valid')
    expect(field.disabled).toBe(false)
    expect(field.value).toBe('')
    expect(document.activeElement).toBe(field)
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

  it('the signed-out door wears the custom brand: its name and mark', async () => {
    serve(SIGNED_OUT)
    brand = { ...CEZAR_BRAND, name: 'Agents', logoUrl: '/api/v1/workspace/branding-logo?v=abcdefabcdef', custom: true }
    renderGate()
    await screen.findByLabelText('Username')
    await waitFor(() => expect(document.querySelector('[data-slot="brand-name"]')?.textContent).toBe('Agents'))
    expect(document.querySelector<HTMLImageElement>('[data-slot="brand-logo"]')?.getAttribute('src')).toBe('/api/v1/workspace/branding-logo?v=abcdefabcdef')
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
