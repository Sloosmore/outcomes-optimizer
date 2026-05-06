/**
 * Error path tests: verify BFF routes return correct 4xx/5xx responses for invalid inputs.
 *
 * Uses Hono's app.request() for unit-style testing without a running server.
 * All tests mock the service layer and JWT middleware to isolate route logic.
 */
import { vi, describe, it, expect, beforeEach } from 'vitest'
import { Hono } from 'hono'
import type { JWTPayload } from 'jose'

// Mock supabase to prevent process.exit on missing env vars
vi.mock('../lib/supabase.js', () => ({
  supabase: {
    rpc: vi.fn(),
    from: vi.fn(),
    auth: { admin: { generateLink: vi.fn() } },
  }
}))

// Mock services with controllable stubs
const mockProcesses = {
  getById: vi.fn(),
  resolveChain: vi.fn(),
  query: vi.fn(),
}
const mockEvents = {
  getByProcessIds: vi.fn(),
  countByProcessIds: vi.fn(),
}
const mockChats = {
  findById: vi.fn(),
  findRecent: vi.fn(),
  create: vi.fn(),
  updateArtifactTiles: vi.fn(),
  updateStageMode: vi.fn(),
  upsertById: vi.fn(),
}
const mockMessages = {
  findByChatId: vi.fn(),
  create: vi.fn(),
}
const mockMetrics = {
  getLatestSnapshots: vi.fn(),
}
const mockResources = {
  listActive: vi.fn(),
  findByIds: vi.fn(),
  listLinksBetween: vi.fn(),
  list: vi.fn(),
  listAllLinks: vi.fn(),
  listDistinctTypes: vi.fn(),
  findByNameAndType: vi.fn(),
  updateStatusWhere: vi.fn(),
  upsertByName: vi.fn(),
  insertLinkRaw: vi.fn(),
  findByExternalId: vi.fn(),
  listLinksFromId: vi.fn(),
  findByTypeAndIds: vi.fn(),
}

vi.mock('../lib/services.js', () => ({
  getServices: vi.fn(() => ({
    processes: mockProcesses,
    events: mockEvents,
    chats: mockChats,
    messages: mockMessages,
    metrics: mockMetrics,
    resources: mockResources,
  })),
}))

import { processesRouter } from '../routes/processes.js'
import { chatsRouter } from '../routes/chats.js'
import { messagesRouter } from '../routes/messages.js'
import { metricsRouter } from '../routes/metrics.js'

/** Build a test app with mock JWT middleware that injects a valid sub */
function makeApp() {
  const app = new Hono()
  app.use('*', (c, next) => {
    c.set('jwtPayload', { sub: 'test-user' } as JWTPayload)
    return next()
  })
  app.route('/api', processesRouter)
  app.route('/api/chats', chatsRouter)
  app.route('/api/chats', messagesRouter)
  app.route('/api/metrics', metricsRouter)
  return app
}

describe('error path tests', () => {
  let app: ReturnType<typeof makeApp>

  beforeEach(() => {
    vi.clearAllMocks()
    app = makeApp()
  })

  // Test 1: /api/process-events/not-a-uuid → 400 {error: 'Invalid processId'}
  it('1. GET /api/process-events/not-a-uuid → 400 Invalid processId', async () => {
    const res = await app.request('/api/process-events/not-a-uuid')
    expect(res.status).toBe(400)
    const body = await res.json() as { error: string }
    expect(body.error).toBe('Invalid processId')
  })

  // Test 2: /api/process-events/:id?before=garbage → 400 {error: 'Invalid before cursor'}
  it('2. GET /api/process-events/:id?before=garbage → 400 Invalid before cursor', async () => {
    const validUuid = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'
    // Set up mock to return process data so it passes the process lookup
    mockProcesses.getById.mockResolvedValue({ id: validUuid, root_process_id: null })
    mockProcesses.resolveChain.mockResolvedValue([{ id: validUuid }])
    const res = await app.request(`/api/process-events/${validUuid}?before=garbage`)
    expect(res.status).toBe(400)
    const body = await res.json() as { error: string }
    expect(body.error).toBe('Invalid before cursor')
  })

  // Test 3: /api/processes?status=bogus → 400 {error: 'Invalid status value'}
  it('3. GET /api/processes?status=bogus → 400 Invalid status value', async () => {
    const res = await app.request('/api/processes?status=bogus')
    expect(res.status).toBe(400)
    const body = await res.json() as { error: string }
    expect(body.error).toBe('Invalid status value')
  })

  // Test 4: /api/chats/not-a-uuid → 400
  it('4. GET /api/chats/not-a-uuid → 400', async () => {
    const res = await app.request('/api/chats/not-a-uuid')
    expect(res.status).toBe(400)
  })

  // Test 5: POST /api/chats/:id/messages with empty content → 400 (Zod min(1))
  it('5. POST /api/chats/:id/messages with empty content → 400', async () => {
    const validUuid = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'
    const res = await app.request(`/api/chats/${validUuid}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'user', content: '' }),
    })
    expect(res.status).toBe(400)
  })

  // Test 6: /api/metrics/latest?skill_id=not-uuid → 400
  it('6. GET /api/metrics/latest?skill_id=not-uuid → 400', async () => {
    const res = await app.request('/api/metrics/latest?skill_id=not-uuid')
    expect(res.status).toBe(400)
  })

  // Test 7: Service method throws → 500 {error: 'Internal server error'}, no stack trace
  it('7. Service method throws → 500 with no stack trace in response body', async () => {
    // Make processes.query throw to simulate a service failure
    mockProcesses.query = vi.fn().mockRejectedValue(new Error('DB connection refused'))

    // Also need to mock resources.findByIds (used by queryProcesses)
    mockResources.findByIds = vi.fn().mockResolvedValue([])

    const res = await app.request('/api/processes')
    expect(res.status).toBe(500)
    const body = await res.json() as { error: string; stack?: string }
    expect(body.error).toBe('Internal server error')
    // Stack trace must NOT leak in response body
    expect(body.stack).toBeUndefined()
    expect(JSON.stringify(body)).not.toContain('DB connection refused')
  })
})
