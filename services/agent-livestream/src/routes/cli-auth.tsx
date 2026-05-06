// TanStack Router route files — fast-refresh pattern does not apply
// cli-auth: browser-based CLI auth confirmation page — duoidal auth login flow
/* eslint-disable react-refresh/only-export-components */
import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { z } from 'zod'
import { authAdapter, supabaseClient } from '@/config'

function isLocalhostUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    // Only allow plain http (not https/data/javascript/etc) to a loopback host
    if (parsed.protocol !== 'http:') return false
    // Restrict path to /callback to prevent exfiltration to arbitrary localhost endpoints
    if (parsed.pathname !== '/callback') return false
    return parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1'
  } catch {
    return false
  }
}

export const Route = createFileRoute('/cli-auth')({
  validateSearch: z.object({ redirect: z.string().optional() }),
  loader: async ({ context: _ }) => {
    const session = await authAdapter.getSession()
    return { hasSession: !!session }
  },
  component: CliAuthPage,
})

function PageShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <div className="w-full max-w-sm space-y-4 p-8 text-center">{children}</div>
    </div>
  )
}

function CliAuthPage() {
  const { redirect } = Route.useSearch()
  const { hasSession } = Route.useLoaderData()
  const [confirmed, setConfirmed] = useState(false)
  const [step, setStep] = useState<'email' | 'code' | 'sent'>('email')
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [formError, setFormError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [doneMsg, setDoneMsg] = useState<string | null>(null)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  if (!redirect || !isLocalhostUrl(redirect)) {
    return (
      <PageShell>
        <h1 className="text-2xl font-semibold">Invalid request</h1>
        <p className="text-sm text-muted-foreground">
          The redirect URL is missing or invalid. Only localhost redirect URLs are permitted.
        </p>
      </PageShell>
    )
  }

  if (doneMsg) {
    return (
      <PageShell>
        <h1 className="text-2xl font-semibold">Done</h1>
        <p className="text-sm text-muted-foreground">{doneMsg}</p>
      </PageShell>
    )
  }

  if (errorMsg) {
    return (
      <PageShell>
        <h1 className="text-2xl font-semibold">Error</h1>
        <p className="text-sm text-destructive">{errorMsg}</p>
      </PageShell>
    )
  }

  const handleAuthorize = async () => {
    setLoading(true)
    try {
      const { data } = await supabaseClient.auth.getSession()
      const session = data.session
      if (!session) {
        setErrorMsg('No active session. Please retry.')
        return
      }
      const body = {
        access_token: session.access_token,
        refresh_token: session.refresh_token,
        expires_at: session.expires_at,
      }
      const res = await fetch(redirect, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        setErrorMsg('CLI is no longer listening. Please retry `duoidal auth login`')
        return
      }
      setDoneMsg('You can close this tab')
    } catch {
      setErrorMsg('CLI is no longer listening. Please retry `duoidal auth login`')
    } finally {
      setLoading(false)
    }
  }

  if (hasSession || confirmed) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="w-full max-w-sm space-y-6 p-8">
          <div className="text-center space-y-2">
            <h1 className="text-2xl font-semibold">Authorize duoidal CLI?</h1>
            <p className="text-sm text-muted-foreground">
              The app <span className="font-medium">duoidal</span> is requesting access to your account.
            </p>
          </div>
          <div className="space-y-3">
            <button
              onClick={handleAuthorize}
              disabled={loading}
              className="w-full bg-primary text-primary-foreground rounded px-4 py-2 text-sm font-medium disabled:opacity-50"
            >
              {loading ? 'Authorizing…' : 'Authorize duoidal CLI'}
            </button>
            <button
              onClick={() => setDoneMsg('Authorization cancelled. You can close this tab')}
              disabled={loading}
              className="w-full border rounded px-4 py-2 text-sm font-medium bg-background disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    )
  }

  if (step === 'sent') {
    return (
      <PageShell>
        <h1 className="text-2xl font-semibold">Check your email</h1>
        <p className="text-sm text-muted-foreground">We sent a magic link to {email}. Click it to sign in.</p>
      </PageShell>
    )
  }

  // After magic link click, user must land back on /cli-auth with the
  // localhost redirect param so the authorization handshake completes.
  const cliReturnTo = `/cli-auth?redirect=${encodeURIComponent(redirect)}`

  const handleEmailSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setFormError(null)
    try {
      if ('signInReturning' in authAdapter && typeof authAdapter.signInReturning === 'function') {
        const result = await authAdapter.signInReturning(email, { returnTo: cliReturnTo })
        if (result.status === 'ok') {
          setStep('sent')
        } else if (result.status === 'not-found') {
          setStep('code')
        } else {
          setFormError(result.error.message)
        }
      } else {
        setStep('code')
      }
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Something went wrong')
    } finally {
      setLoading(false)
    }
  }

  const handleCodeSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setFormError(null)
    try {
      const { error: signInError } = await authAdapter.signIn(email, code, { returnTo: cliReturnTo })
      if (signInError) {
        setFormError(signInError.message)
        return
      }
      setConfirmed(true)
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Something went wrong')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <div className="w-full max-w-sm space-y-4 p-8">
        <h1 className="text-2xl font-semibold text-center">Sign in to continue</h1>
        <p className="text-sm text-muted-foreground text-center">
          Sign in to authorize <span className="font-medium">duoidal</span> CLI access.
        </p>
        {step === 'email' && (
          <form onSubmit={handleEmailSubmit} className="space-y-4">
            <div>
              <label htmlFor="email" className="block text-sm font-medium mb-1">Email</label>
              <input
                id="email"
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                required
                className="w-full border rounded px-3 py-2 text-sm bg-background"
                placeholder="you@example.com"
              />
            </div>
            {formError && <p className="text-sm text-destructive">{formError}</p>}
            <button
              type="submit"
              disabled={loading}
              className="w-full bg-primary text-primary-foreground rounded px-4 py-2 text-sm font-medium disabled:opacity-50"
            >
              {loading ? 'Checking…' : 'Continue'}
            </button>
          </form>
        )}
        {step === 'code' && (
          <form onSubmit={handleCodeSubmit} className="space-y-4">
            <p className="text-sm text-muted-foreground">
              No account found for <span className="font-medium">{email}</span>. Enter your access code to request an invite.
            </p>
            <div>
              <label htmlFor="code" className="block text-sm font-medium mb-1">Access Code</label>
              <input
                id="code"
                type="text"
                value={code}
                onChange={e => setCode(e.target.value)}
                required
                autoFocus
                className="w-full border rounded px-3 py-2 text-sm bg-background"
                placeholder="Your invite code"
              />
            </div>
            {formError && <p className="text-sm text-destructive">{formError}</p>}
            <button
              type="submit"
              disabled={loading}
              className="w-full bg-primary text-primary-foreground rounded px-4 py-2 text-sm font-medium disabled:opacity-50"
            >
              {loading ? 'Sending…' : 'Request Access'}
            </button>
          </form>
        )}
      </div>
    </div>
  )
}
