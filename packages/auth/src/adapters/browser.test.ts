import { describe, it, expect, vi, beforeEach } from 'vitest'
import { BrowserAuthAdapter } from './browser.js'
import { AuthError } from './access-code.js'

function makeClient(session: object | null = null, error: object | null = null) {
  return {
    auth: {
      getSession: vi.fn().mockResolvedValue({ data: { session }, error }),
      signOut: vi.fn().mockResolvedValue({}),
    },
  } as any
}

describe('BrowserAuthAdapter', () => {
  it('getToken returns token when session exists', async () => {
    const client = makeClient({
      access_token: 'tok-abc',
      refresh_token: 'ref-abc',
      expires_at: 9999999999,
    })
    const adapter = new BrowserAuthAdapter(client)
    const token = await adapter.getToken()
    expect(token.accessToken).toBe('tok-abc')
    expect(token.refreshToken).toBe('ref-abc')
    expect(token.expiresAt).toBe(9999999999)
  })

  it('getToken throws NOT_AUTHENTICATED when no session', async () => {
    const client = makeClient(null, null)
    const adapter = new BrowserAuthAdapter(client)
    await expect(adapter.getToken()).rejects.toMatchObject({ code: 'NOT_AUTHENTICATED' })
  })

  it('getToken throws NOT_AUTHENTICATED when error returned', async () => {
    const client = makeClient(null, new Error('session error'))
    const adapter = new BrowserAuthAdapter(client)
    await expect(adapter.getToken()).rejects.toMatchObject({ code: 'NOT_AUTHENTICATED' })
  })

  it('isAuthenticated returns true when session exists', async () => {
    const client = makeClient({ access_token: 'tok' })
    const adapter = new BrowserAuthAdapter(client)
    expect(await adapter.isAuthenticated()).toBe(true)
  })

  it('isAuthenticated returns false when no session', async () => {
    const client = makeClient(null)
    const adapter = new BrowserAuthAdapter(client)
    expect(await adapter.isAuthenticated()).toBe(false)
  })

  it('logout calls signOut', async () => {
    const client = makeClient({ access_token: 'tok' })
    const adapter = new BrowserAuthAdapter(client)
    await adapter.logout()
    expect(client.auth.signOut).toHaveBeenCalled()
  })

  it('type discriminant is browser', () => {
    const client = makeClient()
    const adapter = new BrowserAuthAdapter(client)
    expect(adapter.type).toBe('browser')
  })
})
