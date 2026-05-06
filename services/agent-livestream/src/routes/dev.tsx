// TanStack Router route files — fast-refresh pattern does not apply
/* eslint-disable react-refresh/only-export-components */
import { createFileRoute, notFound } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { authAdapter, supabaseClient } from '@/config'

export const Route = createFileRoute('/dev')({
  beforeLoad: () => {
    if (import.meta.env.PROD) throw notFound()
  },
  component: DevPage,
})

function DevPage() {
  const { data: session } = useQuery({
    queryKey: ['dev-auth-session'],
    queryFn: async () => {
      const { data } = await supabaseClient.auth.getSession()
      return data.session
    }
  })

  return (
    <div className="p-8 space-y-4">
      <h1 className="text-2xl font-semibold">Dev Auth Panel</h1>
      <div className="space-y-2 text-sm font-mono">
        <div>Email: {session?.user.email ?? '(not signed in)'}</div>
        <div>Expires: {session?.expires_at ? new Date(session.expires_at * 1000).toISOString() : 'n/a'}</div>
      </div>
      <button
        className="bg-destructive text-destructive-foreground rounded px-4 py-2 text-sm"
        onClick={() => void authAdapter.signOut?.()}
      >
        Sign Out
      </button>
    </div>
  )
}
