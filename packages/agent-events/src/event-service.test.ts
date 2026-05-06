import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock @supabase/supabase-js to prevent real HTTP calls
vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    from: vi.fn(() => ({
      insert: vi.fn(() => Promise.resolve({ error: null }))
    }))
  }))
}))

import { createEventService } from './event-service.js'

const FULL_ENV = {
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SERVICE_KEY: 'service-key-abc',
  EVAL_PROCESS_ID: '00000000-0000-0000-0000-000000000001',
  EVAL_PROCESS: 'test-process'
}

describe('createEventService()', () => {
  const originalEnv: Record<string, string | undefined> = {}

  beforeEach(() => {
    // Save original values
    for (const key of Object.keys(FULL_ENV)) {
      originalEnv[key] = process.env[key]
    }
  })

  afterEach(() => {
    // Restore original values
    for (const key of Object.keys(FULL_ENV)) {
      if (originalEnv[key] === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = originalEnv[key]
      }
    }
  })

  describe('when all 4 env vars are present', () => {
    beforeEach(() => {
      Object.assign(process.env, FULL_ENV)
    })

    it('returns a non-null EventEmitterAdapter', () => {
      const service = createEventService()
      expect(service).not.toBeNull()
    })

    it('returned adapter has an emit() method', () => {
      const service = createEventService()
      expect(typeof service?.emit).toBe('function')
    })

    it('emit() does not throw when called', () => {
      const service = createEventService()
      expect(() => {
        service!.emit({
          process_id: FULL_ENV.EVAL_PROCESS_ID,
          process_name: FULL_ENV.EVAL_PROCESS,
          source: 'test',
          payload: { key: 'value' },
          resource_id: null
        })
      }).not.toThrow()
    })
  })

  describe('when env vars are missing', () => {
    it('returns null when SUPABASE_URL is absent', () => {
      Object.assign(process.env, FULL_ENV)
      delete process.env.SUPABASE_URL
      expect(createEventService()).toBeNull()
    })

    it('returns null when SUPABASE_SERVICE_KEY is absent', () => {
      Object.assign(process.env, FULL_ENV)
      delete process.env.SUPABASE_SERVICE_KEY
      expect(createEventService()).toBeNull()
    })

    it('returns null when EVAL_PROCESS_ID is absent', () => {
      Object.assign(process.env, FULL_ENV)
      delete process.env.EVAL_PROCESS_ID
      expect(createEventService()).toBeNull()
    })

    it('returns null when EVAL_PROCESS is absent', () => {
      Object.assign(process.env, FULL_ENV)
      delete process.env.EVAL_PROCESS
      expect(createEventService()).toBeNull()
    })

    it('returns null when all env vars are absent', () => {
      for (const key of Object.keys(FULL_ENV)) {
        delete process.env[key]
      }
      expect(createEventService()).toBeNull()
    })
  })
})
