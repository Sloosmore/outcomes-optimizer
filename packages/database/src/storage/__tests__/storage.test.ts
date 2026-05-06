/**
 * Unit tests for uploadTrace in packages/database/src/storage/traces.ts
 * No real HTTP calls — @supabase/supabase-js createClient is mocked.
 */

const mockUpload = vi.fn()

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    storage: {
      from: vi.fn(() => ({
        upload: mockUpload,
      })),
    },
  })),
}))

// Import after mock is registered
import { uploadTrace } from '../traces.js'

describe('uploadTrace', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.SUPABASE_URL = 'https://example.supabase.co'
    process.env.SUPABASE_SERVICE_KEY = 'service-key'
    mockUpload.mockResolvedValue({ data: {}, error: null })
  })

  afterEach(() => {
    delete process.env.SUPABASE_URL
    delete process.env.SUPABASE_SERVICE_KEY
    // Reset cached client so env changes take effect across test files
    vi.resetModules()
  })

  it('returns the storage path on success', async () => {
    const sessionId = 'session-abc'
    const result = await uploadTrace(sessionId, 'trace content')
    expect(result).toBe(`${sessionId}.jsonl`)
  })

  it('calling uploadTrace twice with the same sessionId does not throw', async () => {
    const sessionId = 'session-idempotent'
    await expect(uploadTrace(sessionId, 'first call')).resolves.toBe(`${sessionId}.jsonl`)
    await expect(uploadTrace(sessionId, 'second call')).resolves.toBe(`${sessionId}.jsonl`)
  })

  it('returns null when the storage upload fails', async () => {
    mockUpload.mockResolvedValue({ data: null, error: { message: 'bucket not found' } })
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const result = await uploadTrace('session-uploadfail', 'trace content')

    expect(result).toBeNull()
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('[storage] Upload failed:'))

    consoleSpy.mockRestore()
  })

  it('returns null when storage client cannot be initialised (missing env)', async () => {
    delete process.env.SUPABASE_URL
    delete process.env.SUPABASE_SERVICE_KEY
    // The module caches the client — we need a fresh import to exercise the null path.
    // Clear the module registry so getStorageClient re-runs env checks.
    vi.resetModules()
    const { uploadTrace: freshUploadTrace } = await import('../traces.js')
    const result = await freshUploadTrace('session-noenv', 'content')
    expect(result).toBeNull()
  })
})
