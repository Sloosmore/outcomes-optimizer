import { describe, it, expect, vi, beforeEach } from 'vitest'
import { CLIAuthAdapter } from './cli.js'
import { AuthError } from './access-code.js'

function makeClient(overrides: Record<string, any> = {}) {
  return {
    auth: {
      signOut: vi.fn().mockResolvedValue({}),
      verifyOtp: vi.fn().mockResolvedValue({
        data: {
          session: {
            access_token: 'tok-otp',
            refresh_token: 'ref-otp',
            expires_at: 9999999999,
          }
        },
        error: null,
      }),
      exchangeCodeForSession: vi.fn(),
      ...overrides,
    },
  } as any
}

describe('CLIAuthAdapter', () => {
  it('type discriminant is cli', () => {
    const adapter = new CLIAuthAdapter(makeClient())
    expect(adapter.type).toBe('cli')
  })

  it('getToken throws NOT_AUTHENTICATED before login', async () => {
    const adapter = new CLIAuthAdapter(makeClient())
    await expect(adapter.getToken()).rejects.toMatchObject({ code: 'NOT_AUTHENTICATED' })
  })

  it('isAuthenticated returns false before login', async () => {
    const adapter = new CLIAuthAdapter(makeClient())
    expect(await adapter.isAuthenticated()).toBe(false)
  })

  it('loginWithAccessCode delegates to AccessCodeAuthAdapter and stores token', async () => {
    const adapter = new CLIAuthAdapter(makeClient())
    const token = await adapter.loginWithAccessCode('user@test.com', '123456')
    expect(token.accessToken).toBe('tok-otp')
    expect(await adapter.isAuthenticated()).toBe(true)
    const fetched = await adapter.getToken()
    expect(fetched.accessToken).toBe('tok-otp')
  })

  it('loginWithAccessCode throws when OTP fails', async () => {
    const client = makeClient({
      verifyOtp: vi.fn().mockResolvedValue({ data: { session: null }, error: new Error('Bad code') })
    })
    const adapter = new CLIAuthAdapter(client)
    await expect(adapter.loginWithAccessCode('user@test.com', 'bad')).rejects.toMatchObject({ code: 'INVALID_CODE' })
  })

  it('isAuthenticated returns false after token expiry', async () => {
    const client = makeClient({
      verifyOtp: vi.fn().mockResolvedValue({
        data: { session: { access_token: 'tok', refresh_token: null, expires_at: 1 } },
        error: null,
      })
    })
    const adapter = new CLIAuthAdapter(client)
    await adapter.loginWithAccessCode('user@test.com', '123456')
    expect(await adapter.isAuthenticated()).toBe(false)
  })

  it('logout clears token and calls signOut', async () => {
    const client = makeClient()
    const adapter = new CLIAuthAdapter(client)
    await adapter.loginWithAccessCode('user@test.com', '123456')
    await adapter.logout()
    expect(await adapter.isAuthenticated()).toBe(false)
    expect(client.auth.signOut).toHaveBeenCalled()
  })
})

describe('CLIAuthAdapter.startAppFlow', () => {
  it('emits correct OAUTH_URL to stdout', async () => {
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const adapter = new CLIAuthAdapter(makeClient(), { callbackPort: 0, oauthTimeoutMs: 5000 })

    // Start flow without awaiting — server needs a POST to complete
    const flowPromise = adapter.startAppFlow('http://localhost:5173')

    // Wait a tick for server to start and emit the URL
    await new Promise(resolve => setTimeout(resolve, 50))

    // Capture what was written to stdout
    const calls = writeSpy.mock.calls.map(c => String(c[0]))
    const oauthLine = calls.find(s => s.startsWith('OAUTH_URL:'))
    expect(oauthLine).toBeDefined()
    expect(oauthLine).toMatch(
      /^OAUTH_URL:http:\/\/localhost:5173\/cli-auth\?redirect=http%3A%2F%2Flocalhost%3A\d+%2Fcallback\n$/
    )

    // Extract port from redirect param and complete the flow
    const url = new URL(oauthLine!.replace('OAUTH_URL:', '').trim())
    const redirectParam = url.searchParams.get('redirect')!
    const port = new URL(redirectParam).port

    await fetch(`http://localhost:${port}/callback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ access_token: 'tok', refresh_token: 'ref', expires_at: 9999999999 }),
    })

    await flowPromise
    writeSpy.mockRestore()
  })

  it('resolves with token on valid POST to /callback', async () => {
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const adapter = new CLIAuthAdapter(makeClient(), { callbackPort: 0, oauthTimeoutMs: 5000 })

    const flowPromise = adapter.startAppFlow('http://localhost:5173')

    // Wait for server to start
    await new Promise(resolve => setTimeout(resolve, 50))

    const calls = writeSpy.mock.calls.map(c => String(c[0]))
    const oauthLine = calls.find(s => s.startsWith('OAUTH_URL:'))!
    const url = new URL(oauthLine.replace('OAUTH_URL:', '').trim())
    const redirectParam = url.searchParams.get('redirect')!
    const port = new URL(redirectParam).port

    await fetch(`http://localhost:${port}/callback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ access_token: 'test-token', refresh_token: 'test-refresh', expires_at: 9999999999 }),
    })

    const token = await flowPromise
    expect(token).toMatchObject({
      accessToken: 'test-token',
      refreshToken: 'test-refresh',
      expiresAt: 9999999999,
    })

    writeSpy.mockRestore()
  })

  it('rejects after timeout', async () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    // Use a very short timeout so the test completes quickly
    const adapter = new CLIAuthAdapter(makeClient(), { callbackPort: 0, oauthTimeoutMs: 50 })
    const flowPromise = adapter.startAppFlow('http://localhost:5173')
    await expect(flowPromise).rejects.toMatchObject({ code: 'INVALID_CODE' })
    vi.restoreAllMocks()
  })
})
