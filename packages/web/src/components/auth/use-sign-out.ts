import { useQueryClient, type QueryClient } from '@tanstack/react-query'
import { useCallback } from 'react'

import { authQueryKeys, logout } from '@/api/auth'
import { dropDevicePush } from '@/api/push'

/**
 * Drop everything the signed-in cockpit cached, then re-ask who we are. `AuthGate` renders the
 * sign-in screen from that answer; nothing here navigates.
 */
export function resetToSession(queryClient: QueryClient): void {
  queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== 'auth' })
  queryClient.removeQueries({ queryKey: authQueryKeys.devices })
  void queryClient.invalidateQueries({ queryKey: authQueryKeys.session })
}

export function useSignOut(): () => void {
  const queryClient = useQueryClient()
  return useCallback(() => {
    // Even if the request fails the cookie may be gone; either way the session answer decides.
    // This device's push goes first, while its session can still delete its own row.
    void dropDevicePush()
      .then(() => logout())
      .catch(() => undefined)
      .then(() => resetToSession(queryClient))
  }, [queryClient])
}
