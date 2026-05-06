import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// vi.mock calls must be at the top before any imports for hoisting to work

let capturedOnCallback: (() => void) | null = null

const mockChannel = {
  on: vi.fn((_event: string, _filter: unknown, callback: () => void) => {
    capturedOnCallback = callback
    return mockChannel
  }),
  subscribe: vi.fn(() => mockChannel)
}

const mockClient = {
  channel: vi.fn(() => mockChannel),
  removeChannel: vi.fn(() => Promise.resolve())
}

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => mockClient)
}))

const mockEmit = vi.fn()

vi.mock('./event-service.js', () => ({
  createEventService: vi.fn(() => ({ emit: mockEmit }))
}))

import { createWatchdog } from './watchdog.js'
import { EventType } from './event-types.js'
import { createEventService } from './event-service.js'

const ENV = {
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SERVICE_KEY: 'service-key-abc',
  EVAL_PROCESS_ID: '00000000-0000-0000-0000-000000000001',
  EVAL_PROCESS: 'test-process'
}

describe('createWatchdog()', () => {
  const originalEnv: Record<string, string | undefined> = {}

  beforeEach(() => {
    for (const key of Object.keys(ENV)) {
      originalEnv[key] = process.env[key]
    }
    Object.assign(process.env, ENV)
    vi.useFakeTimers()
    mockEmit.mockClear()
    mockClient.channel.mockClear()
    mockChannel.on.mockClear()
    mockChannel.subscribe.mockClear()
    mockClient.removeChannel.mockClear()
    capturedOnCallback = null
  })

  afterEach(() => {
    for (const key of Object.keys(ENV)) {
      if (originalEnv[key] === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = originalEnv[key]
      }
    }
    vi.useRealTimers()
  })

  it('emits PROCESS_STALE after threshold elapses', () => {
    createWatchdog('test-process-id', 2000)

    vi.advanceTimersByTime(2100)

    expect(mockEmit).toHaveBeenCalledOnce()
    const call = mockEmit.mock.calls[0][0]
    expect(call.source).toBe(EventType.PROCESS_STALE)
    expect(call.payload).not.toBeNull()
    expect(call.payload).toMatchObject({
      process_id: 'test-process-id',
      threshold_ms: 2000
    })
  })

  it('returns no-op stop() when SUPABASE_URL is absent', () => {
    delete process.env.SUPABASE_URL

    const watchdog = createWatchdog('test-process-id', 2000)

    expect(mockClient.channel).not.toHaveBeenCalled()
    expect(typeof watchdog.stop).toBe('function')
    expect(() => watchdog.stop()).not.toThrow()
  })

  it('returns no-op stop() when SUPABASE_SERVICE_KEY is absent', () => {
    delete process.env.SUPABASE_SERVICE_KEY

    const watchdog = createWatchdog('test-process-id', 2000)

    expect(mockClient.channel).not.toHaveBeenCalled()
    expect(typeof watchdog.stop).toBe('function')
    expect(() => watchdog.stop()).not.toThrow()
  })

  it('stop() clears the timer so stale event is not emitted', () => {
    const watchdog = createWatchdog('test-process-id', 2000)

    watchdog.stop()

    vi.advanceTimersByTime(2100)

    expect(mockEmit).not.toHaveBeenCalled()
    expect(mockClient.removeChannel).toHaveBeenCalledOnce()
  })

  it('returns no-op stop() when event service is unavailable', () => {
    vi.mocked(createEventService).mockReturnValueOnce(null)

    const watchdog = createWatchdog('test-process-id', 2000)

    expect(mockClient.channel).not.toHaveBeenCalled()
    expect(typeof watchdog.stop).toBe('function')
    expect(() => watchdog.stop()).not.toThrow()

    vi.advanceTimersByTime(2100)

    expect(mockEmit).not.toHaveBeenCalled()
  })

  it('resets timer when a realtime event arrives', () => {
    createWatchdog('test-process-id', 2000)

    // Advance partway through the threshold
    vi.advanceTimersByTime(1500)

    // Simulate a realtime event arriving — this should reset the timer
    capturedOnCallback?.()

    // Advance past the original threshold but not the reset one
    vi.advanceTimersByTime(1500)

    // Should not have fired yet (timer was reset)
    expect(mockEmit).not.toHaveBeenCalled()

    // Advance past the reset threshold
    vi.advanceTimersByTime(600)

    expect(mockEmit).toHaveBeenCalledOnce()
  })
})
