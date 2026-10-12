import { useQuery, useQueryClient } from '@tanstack/react-query'

import type {
  AuthDevicesResponse,
  AuthPasswordBody,
  AuthSessionResponse,
  AuthSetupBeginBody,
  AuthSetupBeginResponse,
  AuthSetupCompleteResponse,
  AuthVerifyResponse,
} from '@open-mercato/cezar-api-client'
import { ApiError, cez, unwrap } from './client'

/**
 * The cockpit's half of sign-in (spec `2026-10-12-cockpit-authentication.md` §8). Workspace-level:
 * these keys are never project-scoped.
 */
export const authQueryKeys = {
  session: ['auth', 'session'] as const,
  devices: ['auth', 'devices'] as const,
}

/** What a cockpit shows when it cannot ask: an older server, or one that is not answering. The
 *  server is the one enforcing, so assuming "no sign-in" here can only show its real error. */
export const OPEN_SESSION: AuthSessionResponse = { enforced: false, authenticated: true, setupRequired: false }

/**
 * A session answer, or the stand-in for one that never came. `unanswered` counts the asks in a
 * row that failed: the stand-in lets a LOCAL cockpit through at once (spec §8), but it is a guess
 * and must not be cached as the answer — behind a proxy it hides Sign out from a signed-in owner.
 */
export type SessionAnswer = AuthSessionResponse & { unanswered?: number }

export async function fetchAuthSession(signal?: AbortSignal, failedBefore = 0): Promise<SessionAnswer> {
  try {
    return await unwrap(await cez.api.v1.auth.session.$get({}, { init: { signal } }), '/auth/session')
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    // A 4xx is the considered answer of a server that has no such route. Anything else — a
    // proxy's 502, no connection, a page of HTML — is no answer at all.
    if (error instanceof ApiError && error.status >= 400 && error.status < 500) return OPEN_SESSION
    return { ...OPEN_SESSION, unanswered: failedBefore + 1 }
  }
}

/** Timer retries after a failed ask: 1s doubling to 30s, then none — focus and reconnect still ask. */
const SESSION_RETRIES = 6

function sessionRetryDelay(data: SessionAnswer | undefined): number | false {
  const failed = data?.unanswered ?? 0
  if (failed === 0 || failed > SESSION_RETRIES) return false
  return Math.min(1000 * 2 ** (failed - 1), 30_000)
}

/** Fetched once and then kept true by sign-in, sign-out and the 401 listener in `AuthGate` — and
 *  asked again, with a bounded backoff and on focus/reconnect, for as long as it went unanswered. */
export function useAuthSession() {
  const queryClient = useQueryClient()
  return useQuery({
    queryKey: authQueryKeys.session,
    queryFn: ({ signal }) =>
      fetchAuthSession(signal, queryClient.getQueryData<SessionAnswer>(authQueryKeys.session)?.unanswered),
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
    refetchInterval: (query) => sessionRetryDelay(query.state.data),
    // `always`: the stand-in is never stale by the clock. A real answer is left alone.
    refetchOnWindowFocus: (query) => (query.state.data?.unanswered ? 'always' : false),
    refetchOnReconnect: (query) => (query.state.data?.unanswered ? 'always' : false),
  })
}

export async function loginWithPassword(username: string, password: string): Promise<string> {
  const res = await cez.api.v1.auth.login.$post({ json: { username, password } })
  return (await unwrap(res, '/auth/login')).ticket
}

export async function verifyLogin(ticket: string, code: string): Promise<AuthVerifyResponse> {
  return unwrap(await cez.api.v1.auth.login.verify.$post({ json: { ticket, code } }), '/auth/login/verify')
}

export async function beginSetup(input: AuthSetupBeginBody): Promise<AuthSetupBeginResponse> {
  return unwrap(await cez.api.v1.auth.setup.begin.$post({ json: input }), '/auth/setup/begin')
}

export async function completeSetup(ticket: string, code: string): Promise<AuthSetupCompleteResponse> {
  return unwrap(await cez.api.v1.auth.setup.complete.$post({ json: { ticket, code } }), '/auth/setup/complete')
}

export async function logout(): Promise<void> {
  await unwrap(await cez.api.v1.auth.logout.$post({}), '/auth/logout')
}

export async function fetchDevices(signal?: AbortSignal): Promise<AuthDevicesResponse> {
  return unwrap(await cez.api.v1.auth.sessions.$get({}, { init: { signal } }), '/auth/sessions')
}

export function useDevices() {
  return useQuery({ queryKey: authQueryKeys.devices, queryFn: ({ signal }) => fetchDevices(signal) })
}

export async function revokeDevice(id: string): Promise<void> {
  await unwrap(await cez.api.v1.auth.sessions[':id'].$delete({ param: { id } }), '/auth/sessions/:id')
}

export async function revokeOtherDevices(): Promise<number> {
  return (await unwrap(await cez.api.v1.auth.sessions['revoke-others'].$post({}), '/auth/sessions/revoke-others')).revoked
}

export async function changePassword(input: AuthPasswordBody): Promise<number> {
  return (await unwrap(await cez.api.v1.auth.password.$post({ json: input }), '/auth/password')).revoked
}

export async function regenerateRecoveryCodes(code: string): Promise<string[]> {
  const res = await cez.api.v1.auth['recovery-codes'].$post({ json: { code } })
  return (await unwrap(res, '/auth/recovery-codes')).recoveryCodes
}

/**
 * The signed-in user, read from the cache `AuthGate` keeps — never a request of its own, so the
 * shell and the settings registry can ask on every render. Null on a cockpit without sign-in.
 */
export function useSignedInUser(): AuthSessionResponse['user'] | null {
  const session = useQuery({
    queryKey: authQueryKeys.session,
    queryFn: ({ signal }) => fetchAuthSession(signal),
    staleTime: Number.POSITIVE_INFINITY,
    enabled: false,
  })
  return session.data?.enforced ? (session.data.user ?? null) : null
}
