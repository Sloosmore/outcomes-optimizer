import { describe, it, expect, vi, beforeEach } from 'vitest'
import { TableRealtimeAdapter } from '../realtime-adapter'
import type { SessionAdapter } from '@duoidal/auth/adapters'
import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'

// Minimal schema for testing
const TestSchema = z.object({ id: z.string(), value: z.number() })

function makeSessionAdapter(overrides: Partial<SessionAdapter> = {}): SessionAdapter {
  return {
    signIn: vi.fn().mockResolvedValue({ error: null }),
    getSession: vi.fn().mockResolvedValue(null),
    onAuthStateChange: vi.fn().mockReturnValue({ unsubscribe: vi.fn() }),
    signOut: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

function makeSupabaseClient() {
  const channelUnsubscribe = vi.fn().mockResolvedValue(undefined)
  const channel = {
    on: vi.fn().mockReturnThis(),
    subscribe: vi.fn().mockReturnThis(),
    unsubscribe: channelUnsubscribe,
  }
  const client = {
    channel: vi.fn().mockReturnValue(channel),
  } as unknown as SupabaseClient
  return { client, channel, channelUnsubscribe }
}

describe('TableRealtimeAdapter', () => {
  let authAdapter: SessionAdapter
  let client: SupabaseClient
  let channel: ReturnType<typeof makeSupabaseClient>['channel']

  beforeEach(() => {
    authAdapter = makeSessionAdapter()
    ;({ client, channel } = makeSupabaseClient())
  })

  it('calls signIn on subscribe', async () => {
    const adapter = new TableRealtimeAdapter('test_table', TestSchema, client, authAdapter)
    adapter.subscribe(vi.fn())
    await vi.waitUntil(() => (authAdapter.signIn as ReturnType<typeof vi.fn>).mock.calls.length > 0)
    expect(authAdapter.signIn).toHaveBeenCalledOnce()
  })

  it('creates a channel after successful signIn', async () => {
    const adapter = new TableRealtimeAdapter('test_table', TestSchema, client, authAdapter)
    adapter.subscribe(vi.fn())
    await vi.waitUntil(() => (client.channel as ReturnType<typeof vi.fn>).mock.calls.length > 0)
    expect(client.channel).toHaveBeenCalledOnce()
    expect(client.channel).toHaveBeenCalledWith(expect.stringContaining('realtime:test_table:'))
  })

  it('does not create channel when signIn returns error', async () => {
    authAdapter.signIn = vi.fn().mockResolvedValue({ error: new Error('auth failed') })
    const adapter = new TableRealtimeAdapter('test_table', TestSchema, client, authAdapter)
    const onEvent = vi.fn()
    adapter.subscribe(onEvent)
    // Wait for signIn promise to resolve
    await new Promise((r) => setTimeout(r, 10))
    expect(client.channel).not.toHaveBeenCalled()
    expect(onEvent).not.toHaveBeenCalled()
  })

  it('unsubscribes channel and auth listener on cleanup', async () => {
    const authUnsubscribe = vi.fn()
    authAdapter.onAuthStateChange = vi.fn().mockReturnValue({ unsubscribe: authUnsubscribe })
    const adapter = new TableRealtimeAdapter('test_table', TestSchema, client, authAdapter)
    const cleanup = adapter.subscribe(vi.fn())
    await vi.waitUntil(() => (client.channel as ReturnType<typeof vi.fn>).mock.calls.length > 0)
    cleanup()
    expect(authUnsubscribe).toHaveBeenCalledOnce()
    expect(channel.unsubscribe).toHaveBeenCalledOnce()
  })

  it('does not create channel when cancelled before signIn resolves', async () => {
    let resolveSignIn: (val: { error: null }) => void
    authAdapter.signIn = vi.fn().mockReturnValue(
      new Promise<{ error: null }>((r) => { resolveSignIn = r }),
    )
    const adapter = new TableRealtimeAdapter('test_table', TestSchema, client, authAdapter)
    const cleanup = adapter.subscribe(vi.fn())
    cleanup() // Cancel immediately
    resolveSignIn!({ error: null }) // Now resolve
    await new Promise((r) => setTimeout(r, 10))
    expect(client.channel).not.toHaveBeenCalled()
  })

  it('passes parsed events to onEvent callback', async () => {
    let capturedPayloadHandler: ((payload: { new: unknown }) => void) | undefined
    channel.on = vi.fn().mockImplementation((_type, _filter, handler) => {
      capturedPayloadHandler = handler
      return channel
    })
    const onEvent = vi.fn()
    const adapter = new TableRealtimeAdapter('test_table', TestSchema, client, authAdapter)
    adapter.subscribe(onEvent)
    await vi.waitUntil(() => capturedPayloadHandler !== undefined)
    capturedPayloadHandler?.({ new: { id: 'abc', value: 42 } })
    expect(onEvent).toHaveBeenCalledWith({ id: 'abc', value: 42 })
  })

  it('drops invalid payloads without calling onEvent', async () => {
    let capturedPayloadHandler: ((payload: { new: unknown }) => void) | undefined
    channel.on = vi.fn().mockImplementation((_type, _filter, handler) => {
      capturedPayloadHandler = handler
      return channel
    })
    const onEvent = vi.fn()
    const adapter = new TableRealtimeAdapter('test_table', TestSchema, client, authAdapter)
    adapter.subscribe(onEvent)
    await vi.waitUntil(() => capturedPayloadHandler !== undefined)
    capturedPayloadHandler?.({ new: { id: 123, value: 'not-a-number' } }) // wrong types
    expect(onEvent).not.toHaveBeenCalled()
  })

  it('re-signs in when onAuthStateChange fires with null session', async () => {
    let capturedAuthHandler: ((session: null) => void) | undefined
    authAdapter.onAuthStateChange = vi.fn().mockImplementation((handler) => {
      capturedAuthHandler = handler
      return { unsubscribe: vi.fn() }
    })
    const adapter = new TableRealtimeAdapter('test_table', TestSchema, client, authAdapter)
    adapter.subscribe(vi.fn())
    // Wait for initial signIn to complete (sets signingIn = false)
    await vi.waitUntil(() => (client.channel as ReturnType<typeof vi.fn>).mock.calls.length > 0)
    // Simulate session drop — signingIn is now false so re-auth should trigger
    capturedAuthHandler?.(null)
    await new Promise((r) => setTimeout(r, 10))
    // signIn called: once initially + once on session drop
    expect((authAdapter.signIn as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(2)
  })
})
