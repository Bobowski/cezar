import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, type ReactNode } from 'react'

import { authQueryKeys, useAuthSession } from '@/api/auth'
import { onUnauthorized } from '@/api/client'
import { LoginScreen } from './login-screen'
import { SetupScreen, setupCodeFromLocation } from './setup-screen'
import { resetToSession } from './use-sign-out'

/**
 * Nothing below this renders until the cockpit knows it may (spec
 * 2026-10-12-cockpit-authentication §8). It sits ABOVE the event stream and every query on
 * purpose: a signed-out cockpit that mounted them would open a stream and a dozen requests just
 * to collect 401s.
 *
 * On a local cockpit the session answers `enforced: false` and this is one request and no screen.
 * The URL is never touched on the way to sign-in, so signing back in lands where you were.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient()
  const session = useAuthSession()

  // A 401 mid-session — expired, or revoked from another device — re-asks instead of guessing.
  useEffect(
    () => onUnauthorized(() => void queryClient.invalidateQueries({ queryKey: authQueryKeys.session })),
    [queryClient],
  )

  // Whatever the signed-out cockpit cached is somebody's 401; start clean, then re-ask.
  const enter = useCallback(() => resetToSession(queryClient), [queryClient])

  // Quiet while the first answer is on its way: it takes one round trip, and a spinner that
  // flashes for 30 ms on every local load is worse than a frame of background.
  if (session.data === undefined) return <div data-slot="auth-pending" className="min-h-dvh bg-background" />

  const { enforced, authenticated, setupRequired } = session.data
  if (!enforced || authenticated) return children
  // A reset link arrives while an account still exists only in the single-owner sense that the
  // reset already cleared it, so `setupRequired` covers it; the code check keeps a hand-opened
  // `/setup#code=` link from landing on the sign-in form.
  if (setupRequired || setupCodeFromLocation() !== '') return <SetupScreen onDone={enter} />
  return <LoginScreen onSignedIn={enter} />
}
