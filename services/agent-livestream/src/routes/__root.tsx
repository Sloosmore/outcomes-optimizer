// TanStack Router route files — fast-refresh pattern does not apply
/* eslint-disable react-refresh/only-export-components */
import { createRootRouteWithContext, Outlet, useNavigate } from '@tanstack/react-router'
import { useEffect, useRef } from 'react'
import type { QueryClient } from '@tanstack/react-query'
import { authAdapter } from '@/config'

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  component: RootComponent,
})

function RootComponent() {
  const { queryClient } = Route.useRouteContext()
  const navigate = useNavigate()
  const hadSession = useRef(false)

  useEffect(() => {
    // Supabase fires INITIAL_SESSION synchronously on subscription while initial
    // queries are already in-flight. Calling invalidateQueries() at that moment
    // aborts + restarts those requests, causing the "first N calls fail" symptom.
    // Skip invalidation for the first callback (INITIAL_SESSION); only invalidate
    // on real transitions (TOKEN_REFRESHED, subsequent SIGNED_IN, etc.).
    let initialCallbackFired = false
    const { unsubscribe } = authAdapter.onAuthStateChange((session) => {
      const isInitialCallback = !initialCallbackFired
      initialCallbackFired = true

      if (session) {
        hadSession.current = true
        if (!isInitialCallback) {
          void queryClient.invalidateQueries()
        }
      } else if (hadSession.current) {
        // Only redirect on sign-out (had a session, now don't).
        // Initial null (no session on page load) is handled by _authenticated beforeLoad.
        hadSession.current = false
        queryClient.clear()
        void navigate({ to: '/login' })
      }
    })
    return unsubscribe
  // queryClient and navigate are stable refs — no deps needed
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return <Outlet />
}
