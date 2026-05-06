/**
 * Tests for GET /sandbox/bootstrap-check
 *
 * bootstrap.sh is committed at server/bootstrap.sh (single source of truth).
 * sandbox.ts reads it at module load time via __dirname resolution.
 */
import { vi, describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Hono } from 'hono'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Path that sandbox.ts resolves: server/bootstrap.sh (committed)
const BOOTSTRAP_PATH = resolve(__dirname, '../bootstrap.sh')

const TEST_SECRET = 'test-bootstrap-check-secret'

// Mock supabase and services so sandbox.ts can import cleanly
vi.mock('../lib/supabase.js', () => ({
  supabase: { rpc: vi.fn(), from: vi.fn() },
}))

vi.mock('../lib/services.js', () => ({
  getServices: vi.fn(() => ({
    resources: {
      findByTypeAndName: vi.fn(),
      listLinksToId: vi.fn(),
      countLinkedByType: vi.fn(),
      findByTypeAndIds: vi.fn(),
      findLinkByFromAndType: vi.fn(),
      findByExternalId: vi.fn(),
      listLinksFromId: vi.fn(),
      findByTypeAndName_: vi.fn(),
      getById: vi.fn(),
    },
    processes: { getById: vi.fn(), resolveChain: vi.fn(), query: vi.fn(), init: vi.fn() },
    events: { getByProcessIds: vi.fn().mockResolvedValue([]), countByProcessIds: vi.fn().mockResolvedValue(0) },
    chats: { findRecent: vi.fn(), create: vi.fn(), findById: vi.fn(), updateArtifactTiles: vi.fn(), updateStageMode: vi.fn() },
    messages: { findByChatId: vi.fn(), create: vi.fn() },
    metrics: { getLatestSnapshots: vi.fn() },
  })),
}))


let readyRouter: ReturnType<typeof import('../routes/sandbox.js')['createReadyRouter']>
let expectedBytes: number

beforeAll(async () => {
  process.env['PROVISION_SECRET'] = TEST_SECRET

  const { createReadyRouter } = await import('../routes/sandbox.js')
  const { supabase } = await import('../lib/supabase.js')
  readyRouter = createReadyRouter({ db: supabase as any })

  expectedBytes = readFileSync(BOOTSTRAP_PATH).byteLength
})

afterAll(() => {
  delete process.env['PROVISION_SECRET']
})

describe('GET /sandbox/bootstrap-check', () => {
  it('returns 401 without provision secret', async () => {
    const app = new Hono()
    app.route('/sandbox', readyRouter)

    const res = await app.request('/sandbox/bootstrap-check', { method: 'GET' })
    expect(res.status).toBe(401)
  })

  it('returns { loaded: true, bytes: N } when bootstrap.sh is present and secret matches', async () => {
    const app = new Hono()
    app.route('/sandbox', readyRouter)

    const res = await app.request('/sandbox/bootstrap-check', {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${TEST_SECRET}` },
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { loaded: boolean; bytes: number }
    expect(body.loaded).toBe(true)
    expect(body.bytes).toBe(expectedBytes)
    expect(body.bytes).toBeGreaterThan(0)
  })
})
