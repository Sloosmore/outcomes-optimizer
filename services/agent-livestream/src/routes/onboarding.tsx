// TanStack Router route files — fast-refresh pattern does not apply
/* eslint-disable react-refresh/only-export-components */
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { apiFetch } from '@/lib/api-fetch'
import { supabaseClient } from '@/config'
import { CLI_INSTALL_COMMAND } from '@/constants'

export const Route = createFileRoute('/onboarding')({
  component: OnboardingPage,
})

function OnboardingPage() {
  const navigate = useNavigate()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // is_onboarded is set to true in user metadata when the user confirms setup
  const handleDone = async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await apiFetch('/api/onboarded', { method: 'PATCH' })
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { error?: string }
        setError(data.error ?? 'Something went wrong')
        return
      }
      // Refresh the client session so _authenticated.tsx sees updated user_metadata
      await supabaseClient.auth.refreshSession()
      await navigate({ to: '/' })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <div className="w-full max-w-lg space-y-6 p-8">
        <h1 className="text-2xl font-semibold text-center">
          Welcome. Copy this command to get started.
        </h1>
        <div className="rounded-lg bg-muted px-4 py-3 font-mono text-sm select-all text-muted-foreground">
          {CLI_INSTALL_COMMAND}
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <button
          onClick={handleDone}
          disabled={loading}
          className="w-full rounded bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
        >
          {loading ? 'Saving…' : "I've done this"}
        </button>
      </div>
    </div>
  )
}
