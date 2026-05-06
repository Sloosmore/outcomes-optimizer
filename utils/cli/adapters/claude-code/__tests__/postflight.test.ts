/**
 * Unit tests for the traceRecordHook in postflight.ts.
 * All external I/O is mocked — no filesystem or network calls.
 */

// ── hoist mock fns so factories can reference them ────────────────────────────
const {
  mockExistsSync,
  mockReaddirSync,
  mockStatSync,
  mockReadFileSync,
  mockIsDatabaseEnabled,
  mockGetDb,
  mockCloseDb,
  mockIsStorageEnabled,
  mockUploadTrace,
  mockUpsertTag,
  mockAttachTag,
} = vi.hoisted(() => ({
  mockExistsSync: vi.fn(),
  mockReaddirSync: vi.fn(),
  mockStatSync: vi.fn(),
  mockReadFileSync: vi.fn(),
  mockIsDatabaseEnabled: vi.fn(),
  mockGetDb: vi.fn(),
  mockCloseDb: vi.fn(),
  mockIsStorageEnabled: vi.fn(),
  mockUploadTrace: vi.fn(),
  mockUpsertTag: vi.fn(),
  mockAttachTag: vi.fn(),
}))

// ── module mocks ──────────────────────────────────────────────────────────────

vi.mock('fs', () => ({
  existsSync: mockExistsSync,
  readdirSync: mockReaddirSync,
  statSync: mockStatSync,
  readFileSync: mockReadFileSync,
}))

vi.mock('../../../../database/client.js', () => ({
  isDatabaseEnabled: mockIsDatabaseEnabled,
  getDb: mockGetDb,
  closeDb: mockCloseDb,
}))

vi.mock('../../../../database/storage.js', () => ({
  isStorageEnabled: mockIsStorageEnabled,
  uploadTrace: mockUploadTrace,
}))

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({})),
}))

vi.mock('../../../../database/tags.js', () => ({
  upsertTag: mockUpsertTag,
  attachTag: mockAttachTag,
}))

// Import under test AFTER mocks are registered
import { traceRecordHook } from '../postflight.js'
import type { PostflightContext } from '../../../../cli/types.js'
import { homedir } from 'os'
import { join } from 'path'

// ── helpers ───────────────────────────────────────────────────────────────────

const SESSION_ID = 'test-session-id'
const TRACE_CONTENT = '{"event":"test"}\n'
const TRACE_PATH = join(homedir(), '.claude', 'projects', 'proj-hash', `${SESSION_ID}.jsonl`)

function makeContext(overrides: Partial<PostflightContext> = {}): PostflightContext {
  return {
    adapter: 'claude-code',
    sessionId: SESSION_ID,
    success: true,
    cost: 0.01,
    durationMs: 5000,
    configDir: '.claude',
    workingDir: '/tmp/test-workdir',
    skillsDir: '.claude/skills',
    ...overrides,
  }
}

/** Make fs mocks simulate a found trace file at TRACE_PATH */
function setupTraceFileFound(): void {
  mockExistsSync.mockImplementation((p: string) => {
    // The projects dir exists AND the specific trace file exists
    return p.endsWith(join('.claude', 'projects')) || p === TRACE_PATH
  })
  mockReaddirSync.mockReturnValue(['proj-hash'])
  mockStatSync.mockReturnValue({ isDirectory: () => true })
  mockReadFileSync.mockReturnValue(TRACE_CONTENT)
}

/** Make fs mocks simulate a missing trace file */
function setupTraceFileNotFound(): void {
  mockExistsSync.mockImplementation((p: string) => {
    // The projects dir exists but the trace file does not
    return p.endsWith(join('.claude', 'projects'))
  })
  mockReaddirSync.mockReturnValue(['proj-hash'])
  mockStatSync.mockReturnValue({ isDirectory: () => true })
}

const TRACE_UUID = 'trace-uuid-from-db'

/** Minimal drizzle-like db chain: insert().values().onConflictDoUpdate().returning() */
function makeDbMock() {
  const returning = vi.fn().mockResolvedValue([{ id: TRACE_UUID }])
  const onConflictDoUpdate = vi.fn(() => ({ returning }))
  const values = vi.fn(() => ({ onConflictDoUpdate }))
  const insert = vi.fn(() => ({ values }))
  return { insert, values, onConflictDoUpdate, returning }
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('traceRecordHook', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockCloseDb.mockResolvedValue(undefined)
    mockUploadTrace.mockResolvedValue(`${SESSION_ID}.jsonl`)
    mockUpsertTag.mockResolvedValue({ id: 'tag-uuid', name: 'skill:run', createdAt: new Date() })
    mockAttachTag.mockResolvedValue(undefined)
  })

  // ── storage-only path ─────────────────────────────────────────────────────

  describe('storage upload (DB disabled)', () => {
    it('calls uploadTrace with sessionId and file content when storage is enabled', async () => {
      mockIsDatabaseEnabled.mockReturnValue(false)
      mockIsStorageEnabled.mockReturnValue(true)
      setupTraceFileFound()

      await traceRecordHook.run(makeContext())

      expect(mockUploadTrace).toHaveBeenCalledOnce()
      expect(mockUploadTrace).toHaveBeenCalledWith(SESSION_ID, TRACE_CONTENT)
    })

    it('does NOT call closeDb when DB is disabled', async () => {
      mockIsDatabaseEnabled.mockReturnValue(false)
      mockIsStorageEnabled.mockReturnValue(true)
      setupTraceFileFound()

      await traceRecordHook.run(makeContext())

      expect(mockCloseDb).not.toHaveBeenCalled()
    })
  })

  // ── storage disabled ──────────────────────────────────────────────────────

  describe('storage upload (storage disabled)', () => {
    it('does NOT call uploadTrace when storage is disabled', async () => {
      mockIsDatabaseEnabled.mockReturnValue(false)
      mockIsStorageEnabled.mockReturnValue(false)
      setupTraceFileFound()

      await traceRecordHook.run(makeContext())

      expect(mockUploadTrace).not.toHaveBeenCalled()
    })

    it('returns early without error when both DB and storage are disabled', async () => {
      mockIsDatabaseEnabled.mockReturnValue(false)
      mockIsStorageEnabled.mockReturnValue(false)
      setupTraceFileFound()

      await expect(traceRecordHook.run(makeContext())).resolves.toBeUndefined()
    })
  })

  // ── DB path ───────────────────────────────────────────────────────────────

  describe('DB insert (DB enabled)', () => {
    it('inserts a DB record when DB is enabled', async () => {
      const db = makeDbMock()
      mockIsDatabaseEnabled.mockReturnValue(true)
      mockIsStorageEnabled.mockReturnValue(false)
      mockGetDb.mockReturnValue(db)
      setupTraceFileFound()

      await traceRecordHook.run(makeContext())

      expect(db.insert).toHaveBeenCalledWith(expect.anything()) // traces table
      expect(db.values).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: SESSION_ID, filePath: TRACE_PATH })
      )
      expect(db.onConflictDoUpdate).toHaveBeenCalledOnce()
      expect(db.returning).toHaveBeenCalledOnce()
    })

    it('calls closeDb after DB insert', async () => {
      const db = makeDbMock()
      mockIsDatabaseEnabled.mockReturnValue(true)
      mockIsStorageEnabled.mockReturnValue(false)
      mockGetDb.mockReturnValue(db)
      setupTraceFileFound()

      await traceRecordHook.run(makeContext())

      expect(mockCloseDb).toHaveBeenCalledOnce()
    })

    it('logs a warning when upsert returns empty array, does not throw, and skips tag attachment', async () => {
      const returning = vi.fn().mockResolvedValue([])
      const onConflictDoUpdate = vi.fn(() => ({ returning }))
      const values = vi.fn(() => ({ onConflictDoUpdate }))
      const insert = vi.fn(() => ({ values }))
      mockIsDatabaseEnabled.mockReturnValue(true)
      mockIsStorageEnabled.mockReturnValue(true)
      mockGetDb.mockReturnValue({ insert, values, onConflictDoUpdate, returning })
      setupTraceFileFound()

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        await expect(traceRecordHook.run(makeContext())).resolves.toBeUndefined()

        expect(warnSpy).toHaveBeenCalledOnce()
        expect(warnSpy).toHaveBeenCalledWith(
          `[postflight] upsert returned no ID — tag attachment skipped (sessionId: ${SESSION_ID})`
        )
        expect(mockUpsertTag).not.toHaveBeenCalled()
        expect(mockAttachTag).not.toHaveBeenCalled()
      } finally {
        warnSpy.mockRestore()
      }
    })

    it('still calls closeDb even when DB insert throws', async () => {
      mockIsDatabaseEnabled.mockReturnValue(true)
      mockIsStorageEnabled.mockReturnValue(false)
      const returning = vi.fn().mockRejectedValue(new Error('connection refused'))
      const onConflictDoUpdate = vi.fn(() => ({ returning }))
      const values = vi.fn(() => ({ onConflictDoUpdate }))
      const insert = vi.fn(() => ({ values }))
      mockGetDb.mockReturnValue({ insert, values, onConflictDoUpdate, returning })
      setupTraceFileFound()

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      await traceRecordHook.run(makeContext())

      expect(mockCloseDb).toHaveBeenCalledOnce()
      consoleSpy.mockRestore()
    })
  })

  // ── trace file not found ──────────────────────────────────────────────────

  describe('graceful skip when trace file is missing', () => {
    it('does not throw and does not call uploadTrace', async () => {
      mockIsDatabaseEnabled.mockReturnValue(false)
      mockIsStorageEnabled.mockReturnValue(true)
      setupTraceFileNotFound()

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      await expect(traceRecordHook.run(makeContext())).resolves.toBeUndefined()
      expect(mockUploadTrace).not.toHaveBeenCalled()
      consoleSpy.mockRestore()
    })

    it('does not throw and does not call DB insert', async () => {
      const db = makeDbMock()
      mockIsDatabaseEnabled.mockReturnValue(true)
      mockIsStorageEnabled.mockReturnValue(false)
      mockGetDb.mockReturnValue(db)
      setupTraceFileNotFound()

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      await expect(traceRecordHook.run(makeContext())).resolves.toBeUndefined()
      expect(db.insert).not.toHaveBeenCalled()
      consoleSpy.mockRestore()
    })
  })

  // ── non-claude-code adapter ───────────────────────────────────────────────

  it('is a no-op for non-claude-code adapters', async () => {
    mockIsDatabaseEnabled.mockReturnValue(true)
    mockIsStorageEnabled.mockReturnValue(true)
    setupTraceFileFound()

    await traceRecordHook.run(makeContext({ adapter: 'codex' }))

    expect(mockUploadTrace).not.toHaveBeenCalled()
    expect(mockGetDb).not.toHaveBeenCalled()
  })

  // ── tag attachment ────────────────────────────────────────────────────────

  describe('tag attachment after storage upload', () => {
    it('calls upsertTag and attachTag when both storage and DB are enabled and upload succeeds', async () => {
      const db = makeDbMock()
      mockIsDatabaseEnabled.mockReturnValue(true)
      mockIsStorageEnabled.mockReturnValue(true)
      mockGetDb.mockReturnValue(db)
      setupTraceFileFound()

      await traceRecordHook.run(makeContext())

      expect(mockUpsertTag).toHaveBeenCalledOnce()
      expect(mockUpsertTag).toHaveBeenCalledWith('skill:run')
      expect(mockAttachTag).toHaveBeenCalledOnce()
      expect(mockAttachTag).toHaveBeenCalledWith(TRACE_UUID, 'trace', 'tag-uuid')
      // closeDb called once at the end after all DB operations complete
      expect(mockCloseDb).toHaveBeenCalledTimes(1)
    })

    it('does NOT call upsertTag/attachTag when storage is enabled but DB is disabled', async () => {
      mockIsDatabaseEnabled.mockReturnValue(false)
      mockIsStorageEnabled.mockReturnValue(true)
      setupTraceFileFound()

      await traceRecordHook.run(makeContext())

      expect(mockUpsertTag).not.toHaveBeenCalled()
      expect(mockAttachTag).not.toHaveBeenCalled()
    })

    it('does NOT call upsertTag/attachTag when uploadTrace returns null', async () => {
      const db = makeDbMock()
      mockIsDatabaseEnabled.mockReturnValue(true)
      mockIsStorageEnabled.mockReturnValue(true)
      mockUploadTrace.mockResolvedValue(null)
      mockGetDb.mockReturnValue(db)
      setupTraceFileFound()

      await traceRecordHook.run(makeContext())

      expect(mockUpsertTag).not.toHaveBeenCalled()
      expect(mockAttachTag).not.toHaveBeenCalled()
    })

    it('does not throw when tag attachment fails (error is swallowed)', async () => {
      const db = makeDbMock()
      mockIsDatabaseEnabled.mockReturnValue(true)
      mockIsStorageEnabled.mockReturnValue(true)
      mockGetDb.mockReturnValue(db)
      mockUpsertTag.mockRejectedValue(new Error('tag insert failed'))
      setupTraceFileFound()

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      await expect(traceRecordHook.run(makeContext())).resolves.toBeUndefined()
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('[postflight] Tag attachment failed:'))
      consoleSpy.mockRestore()
    })
  })
})
