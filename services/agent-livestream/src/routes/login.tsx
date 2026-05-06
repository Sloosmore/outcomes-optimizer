// TanStack Router route files — fast-refresh pattern does not apply
/* eslint-disable react-refresh/only-export-components */
import { createFileRoute, redirect } from '@tanstack/react-router'
import { useState } from 'react'
import { authAdapter } from '@/config'
import { DEFAULT_SEARCH_PARAMS } from '@/adapters/layout/registry'

export const Route = createFileRoute('/login')({
  beforeLoad: async () => {
    const session = await authAdapter.getSession()
    if (session) {
      const params = new URLSearchParams(window.location.search)
      const returnTo = params.get('returnTo')
      if (returnTo && returnTo.startsWith('/') && !returnTo.startsWith('//')) throw redirect({ to: returnTo })
      throw redirect({ to: '/', search: { ...DEFAULT_SEARCH_PARAMS, activeTypes: [] as string[] } })
    }
  },
  component: LoginPage,
})

function AccessCodeStep({
  email,
  code,
  setCode,
  error,
  loading,
  onSubmit,
}: {
  email: string
  code: string
  setCode: (v: string) => void
  error: string | null
  loading: boolean
  onSubmit: (e: React.FormEvent) => void
}) {
  return (
    <form onSubmit={onSubmit} className="space-y-4">
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
      {error && <p className="text-sm text-destructive">{error}</p>}
      <button
        type="submit"
        disabled={loading}
        className="w-full bg-primary text-primary-foreground rounded px-4 py-2 text-sm font-medium disabled:opacity-50"
      >
        {loading ? 'Sending…' : 'Request Access'}
      </button>
    </form>
  )
}

function LoginPage() {
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [step, setStep] = useState<'email' | 'code' | 'done'>('email')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const handleEmailSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError(null)
    try {
      if ('signInReturning' in authAdapter && typeof authAdapter.signInReturning === 'function') {
        const result = await authAdapter.signInReturning(email)
        if (result.status === 'ok') {
          setStep('done')
        } else if (result.status === 'not-found') {
          setStep('code')
        } else {
          setError(result.error.message)
        }
      } else {
        // Fallback: go directly to code step if signInReturning unavailable
        setStep('code')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
    } finally {
      setLoading(false)
    }
  }

  const handleCodeSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError(null)
    try {
      const { error: signInError } = await authAdapter.signIn(email, code)
      if (signInError) {
        setError(signInError.message)
        return
      }
      setStep('done')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
    } finally {
      setLoading(false)
    }
  }

  if (step === 'done') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="w-full max-w-sm space-y-4 p-8 text-center">
          <h1 className="text-2xl font-semibold">Check your email</h1>
          <p className="text-sm text-muted-foreground">We sent a magic link to {email}. Click it to sign in.</p>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <div className="w-full max-w-sm space-y-4 p-8">
        <h1 className="text-2xl font-semibold text-center">Sign in</h1>
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
            {error && <p className="text-sm text-destructive">{error}</p>}
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
          <AccessCodeStep
            email={email}
            code={code}
            setCode={setCode}
            error={error}
            loading={loading}
            onSubmit={handleCodeSubmit}
          />
        )}
      </div>
    </div>
  )
}
