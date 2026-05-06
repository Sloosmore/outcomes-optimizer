import { vi, describe, it, expect, beforeEach } from 'vitest'
import { Hono } from 'hono'

// Mock supabase BEFORE imports that use it
// Build a proxy-based chainable mock where every method returns the same proxy,
// except .single() and .limit() which resolve to leaf values,
// and the proxy itself is thenable (resolves on await).
function makeChainableQuery(terminalValue = { data: [] as unknown[], error: null as null }): Record<string, unknown> {
  const resolvedValue = { ...terminalValue }
  // We need .in() to be both chainable and awaitable for the count query
  // So we use a thenable object that also has all chain methods
  const handler: ProxyHandler<object> = {
    get(_target, prop) {
      if (prop === 'then') {
        // Make the object thenable — resolves to { data: [], error: null }
        return (resolve: (v: unknown) => void) => resolve(resolvedValue)
      }
      if (prop === 'single') {
        return vi.fn().mockResolvedValue({ data: null, error: null })
      }
      if (prop === 'limit') {
        return vi.fn().mockResolvedValue(resolvedValue)
      }
      // All other chainable methods return the same proxy
      return () => proxy
    }
  }
  const proxy = new Proxy({}, handler)
  return proxy as Record<string, unknown>
}

vi.mock('../lib/supabase.js', () => ({
  supabase: {
    from: vi.fn().mockReturnValue(makeChainableQuery()),
    rpc: vi.fn().mockResolvedValue({ data: [], error: null }),
  },
}))

// Routes now use getServices() (SQL-based) rather than the supabase client directly.
// Mock the services layer so contract tests can run without a live database connection.
vi.mock('../lib/services.js', () => ({
  getServices: vi.fn(() => ({
    processes: {
      getById: vi.fn().mockResolvedValue(null),
      resolveChain: vi.fn().mockResolvedValue([]),
      query: vi.fn().mockResolvedValue([]),
      init: vi.fn().mockResolvedValue('00000000-0000-4000-8000-000000000000'),
    },
    events: {
      getByProcessIds: vi.fn().mockResolvedValue([]),
      countByProcessIds: vi.fn().mockResolvedValue(0),
    },
    resources: {
      findByExternalId: vi.fn().mockResolvedValue(null),
      listLinksFromId: vi.fn().mockResolvedValue([]),
      findByTypeAndIds: vi.fn().mockResolvedValue([]),
      listActive: vi.fn().mockResolvedValue([]),
      findByIds: vi.fn().mockResolvedValue([]),
      listLinksBetween: vi.fn().mockResolvedValue([]),
      listAllLinks: vi.fn().mockResolvedValue([]),
      resolveUserProjects: vi.fn().mockResolvedValue(new Set()),
    },
    chats: {
      findRecent: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockResolvedValue({ id: '00000000-0000-4000-8000-000000000000', title: 'test', created_at: new Date().toISOString(), artifact_tiles: [], stage_mode: false }),
      findById: vi.fn().mockImplementation((id: string) => {
        if (id === '00000000-0000-4000-8000-000000000000') {
          return Promise.resolve({ id, title: 'test', created_at: new Date().toISOString(), artifact_tiles: [{ url: 'https://example.com/' }], stage_mode: false })
        }
        return Promise.resolve(null)
      }),
      updateArtifactTiles: vi.fn().mockResolvedValue({ id: '00000000-0000-4000-8000-000000000000', title: 'test', created_at: new Date().toISOString(), artifact_tiles: [{ url: 'https://example.com/' }], stage_mode: false }),
      updateStageMode: vi.fn().mockResolvedValue({ id: '00000000-0000-4000-8000-000000000000', title: 'test', created_at: new Date().toISOString(), artifact_tiles: [], stage_mode: true }),
    },
    messages: {
      findByChatId: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockResolvedValue({ id: '00000000-0000-4000-8000-000000000001', chat_id: '00000000-0000-4000-8000-000000000000', role: 'user', content: 'test', created_at: new Date().toISOString() }),
    },
    metrics: {
      getLatestSnapshots: vi.fn().mockResolvedValue([]),
    },
  })),
}))

vi.mock('../tools.js', () => ({
  getAllToolDefs: vi.fn().mockReturnValue([]),
  getToolDef: vi.fn().mockReturnValue(null),
}))

vi.mock('../prompts/system-prompt.js', () => ({
  buildSystemPrompt: () => 'test prompt',
}))

import { processesRouter } from '../routes/processes.js'
import { toolsRouter } from '../routes/tools.js'
import { chatConfigRouter } from '../routes/chat-config.js'
import { orgRouter } from '../routes/org.js'
import { chatsRouter } from '../routes/chats.js'

import { ApiProcessEventsResponse } from '@skill-networks/contracts/processes'
import { ApiToolsListResponse } from '@skill-networks/contracts/tools'
import { ApiChatConfigResponse, ApiArtifactPatchResponse, ApiArtifactActivateResponse, ApiStageModePatchResponse } from '@skill-networks/contracts/chat'
import { ApiOrgResponse } from '@skill-networks/contracts/org'

describe('Route contract tests', () => {
  describe('GET /process-events/:id response parses through ApiProcessEventsResponse', () => {
    it('returns parseable response for valid processId', async () => {
      const app = new Hono()
      // Mock JWT payload so scoping middleware doesn't crash
      app.use('*', async (c, next) => {
        c.set('jwtPayload', { sub: 'test-user-id' })
        await next()
      })
      app.route('/', processesRouter)

      const res = await app.request(
        '/process-events/00000000-0000-4000-8000-000000000000',
        { method: 'GET' },
      )
      expect(res.status).toBe(200)

      const body = await res.json()
      const parsed = ApiProcessEventsResponse.safeParse(body)
      expect(parsed.success).toBe(true)
    })
  })

  describe('GET /api/tools response parses through ApiToolsListResponse', () => {
    it('returns parseable response', async () => {
      const app = new Hono()
      app.route('/', toolsRouter)

      const res = await app.request('/', { method: 'GET' })
      expect(res.status).toBe(200)

      const body = await res.json()
      const parsed = ApiToolsListResponse.safeParse(body)
      expect(parsed.success).toBe(true)
    })
  })

  describe('GET /api/chat/config response parses through ApiChatConfigResponse', () => {
    it('returns parseable response', async () => {
      const app = new Hono()
      app.route('/', chatConfigRouter)

      const res = await app.request('/', { method: 'GET' })
      expect(res.status).toBe(200)

      const body = await res.json()
      const parsed = ApiChatConfigResponse.safeParse(body)
      expect(parsed.success).toBe(true)
    })
  })

  describe('GET /api/org response parses through ApiOrgResponse', () => {
    it('returns parseable response', async () => {
      const app = new Hono()
      app.use('/*', (c, next) => {
        c.set('jwtPayload', { sub: 'test-user-id', aud: 'authenticated' })
        return next()
      })
      app.route('/', orgRouter)

      const res = await app.request('/', { method: 'GET' })
      expect(res.status).toBe(200)

      const body = await res.json()
      const parsed = ApiOrgResponse.safeParse(body)
      expect(parsed.success).toBe(true)
    })
  })

  describe('PATCH /api/chats/:id/artifact response parses through ApiArtifactPatchResponse', () => {
    it('returns parseable response', async () => {
      const app = new Hono()
      app.route('/', chatsRouter)

      const res = await app.request(
        '/00000000-0000-4000-8000-000000000000/artifact',
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: 'https://example.com/' }),
        },
      )
      expect(res.status).toBe(200)

      const body = await res.json()
      const parsed = ApiArtifactPatchResponse.safeParse(body)
      expect(parsed.success).toBe(true)
    })
  })

  describe('POST /api/chats/:id/artifact/activate', () => {
    it('returns parseable response when URL is on rail', async () => {
      const app = new Hono()
      app.route('/', chatsRouter)

      const res = await app.request(
        '/00000000-0000-4000-8000-000000000000/artifact/activate',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: 'https://example.com/' }),
        },
      )
      expect(res.status).toBe(200)

      const body = await res.json()
      const parsed = ApiArtifactActivateResponse.safeParse(body)
      expect(parsed.success).toBe(true)
    })

    it('returns 400 when URL is not on rail', async () => {
      const app = new Hono()
      app.route('/', chatsRouter)

      const res = await app.request(
        '/00000000-0000-4000-8000-000000000000/artifact/activate',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: 'https://not-on-rail.example.com/' }),
        },
      )
      expect(res.status).toBe(400)
    })

    it('returns 400 for invalid UUID', async () => {
      const app = new Hono()
      app.route('/', chatsRouter)

      const res = await app.request(
        '/not-a-uuid/artifact/activate',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: 'https://example.com/' }),
        },
      )
      expect(res.status).toBe(400)
    })
  })

  describe('PATCH /api/chats/:id/stage-mode', () => {
    it('returns parseable response', async () => {
      const app = new Hono()
      app.route('/', chatsRouter)

      const res = await app.request(
        '/00000000-0000-4000-8000-000000000000/stage-mode',
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: true }),
        },
      )
      expect(res.status).toBe(200)

      const body = await res.json()
      const parsed = ApiStageModePatchResponse.safeParse(body)
      expect(parsed.success).toBe(true)
    })

    it('returns 404 when chat does not exist', async () => {
      const app = new Hono()
      app.route('/', chatsRouter)

      const res = await app.request(
        '/00000000-0000-4000-8000-000000000001/stage-mode',
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: true }),
        },
      )
      expect(res.status).toBe(404)
    })

    it('returns 400 for invalid UUID', async () => {
      const app = new Hono()
      app.route('/', chatsRouter)

      const res = await app.request(
        '/not-a-uuid/stage-mode',
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: true }),
        },
      )
      expect(res.status).toBe(400)
    })
  })
})
