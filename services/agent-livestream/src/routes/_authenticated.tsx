// TanStack Router route files — fast-refresh pattern does not apply
/* eslint-disable react-refresh/only-export-components */
import { createFileRoute, redirect, Outlet } from '@tanstack/react-router'
import { useState } from 'react'
import { TooltipProvider } from '@/components/ui/tooltip'
import { SidebarProvider, SidebarInset } from '@/components/ui/sidebar'
import { AppSidebar } from '@/components/app-sidebar'
import { AppTopBar } from '@/components/app-top-bar'
import { TopBarRightSlotContext } from '@/components/top-bar-slot'
import { authAdapter } from '@/config'
import { apiFetch } from '@/lib/api-fetch'
import type { ApiOrgResponse } from '@skill-networks/contracts/org'

export const Route = createFileRoute('/_authenticated')({
  beforeLoad: async ({ location, context }) => {
    let session = null
    if (authAdapter) {
      let s = await authAdapter.getSession()
      if (!s) {
        const { error } = await authAdapter.signIn()
        if (!error) s = await authAdapter.getSession()
      }
      if (!s) {
        throw redirect({ to: '/login', search: { returnTo: location.href } })
      }
      session = s
    }
    // is_onboarded gate: redirect new users to /onboarding unless ?override=true
    const override = new URLSearchParams(location.search).get('override') === 'true'
    if (!override) {
      const isOnboarded = session?.user?.metadata?.['is_onboarded']
      if (!isOnboarded) throw redirect({ to: '/onboarding' })
    }
    // Fetch org data once here and seed the React Query cache under ['org'].
    // AppSidebar and AppTopBar use useQuery(['org']) — seeding here means they
    // get data immediately from cache instead of firing a redundant network call
    // on mount (which would be one of the "first few calls fail" requests).
    const orgRes = await apiFetch('/api/org')
    const orgData: ApiOrgResponse = orgRes.ok ? await orgRes.json() : { projects: [] }
    // Only seed the cache on success — a failed fetch shouldn't cache empty projects
    // or AppSidebar/AppTopBar will wait 60s (staleTime) before their queryFn retries.
    if (orgRes.ok) context.queryClient.setQueryData(['org'], orgData)
    return { orgData }
  },
  component: AuthenticatedLayout,
})

function AuthenticatedLayout() {
  const [rightSlot, setRightSlot] = useState<HTMLElement | null>(null)
  // Embed mode: when the page is rendered inside an iframe (e.g. dispatch's
  // /p/<project>?focusType=skill iframe inside the chat), `?embed=1` strips
  // the surrounding chrome (sidebar, top bar, project switcher, theme/dials
  // toggles) so the focused content fills the iframe without duplicate UI.
  // The query param sticks to the URL so client-side route changes inside
  // the iframe stay in embed mode.
  const isEmbed = typeof window !== 'undefined'
    && new URLSearchParams(window.location.search).get('embed') === '1'

  if (isEmbed) {
    return (
      <TooltipProvider>
        <div className="h-svh max-h-svh overflow-hidden">
          <Outlet />
        </div>
      </TooltipProvider>
    )
  }

  return (
    <TopBarRightSlotContext.Provider value={rightSlot}>
      <TooltipProvider>
        <SidebarProvider defaultOpen={false} className="h-svh max-h-svh overflow-hidden bg-sidebar">
          <AppSidebar />
          <SidebarInset className="m-2 overflow-hidden rounded-xl border">
            <AppTopBar onRightSlot={setRightSlot} />
            <div className="border-t shrink-0" />
            <div className="flex-1 min-h-0 overflow-hidden">
              <Outlet />
            </div>
          </SidebarInset>
        </SidebarProvider>
      </TooltipProvider>
    </TopBarRightSlotContext.Provider>
  )
}
