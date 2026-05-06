import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { adminCommand } from '../commands/admin.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Run the admin approve-user subcommand */
async function runApproveUser(args: string[]): Promise<void> {
  const cmd = adminCommand()
  cmd.exitOverride()
  const approveCmd = cmd.commands.find((c) => c.name() === 'approve-user')
  if (approveCmd) approveCmd.exitOverride()
  await cmd.parseAsync(['node', 'duoidal', 'approve-user', ...args])
}

/** Build a mock Response */
function mockResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    url: 'https://test.supabase.co/rest/v1/resources',
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.stubEnv('SUPABASE_SERVICE_KEY', 'test-service-key')
  vi.stubEnv('SUPABASE_URL', 'https://test.supabase.co')
  vi.unstubAllGlobals()
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

describe('admin approve-user — input validation', () => {
  it('exits with non-zero when --email is invalid', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called')
    }) as (code?: string | number | null) => never)
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(runApproveUser(['--email', 'not-an-email'])).rejects.toThrow()
    expect(exitSpy).toHaveBeenCalledWith(1)
    const errors = consoleErrorSpy.mock.calls.map(c => String(c[0])).join('\n')
    expect(errors).toMatch(/valid email/i)
  })

  it('exits with non-zero when SUPABASE_SERVICE_KEY is missing', async () => {
    vi.stubEnv('SUPABASE_SERVICE_KEY', '')
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called')
    }) as (code?: string | number | null) => never)
    vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(runApproveUser(['--email', 'user@example.com'])).rejects.toThrow()
    expect(exitSpy).toHaveBeenCalledWith(1)
  })

  it('exits with non-zero when SUPABASE_URL is missing', async () => {
    vi.stubEnv('SUPABASE_URL', '')
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called')
    }) as (code?: string | number | null) => never)
    vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(runApproveUser(['--email', 'user@example.com'])).rejects.toThrow()
    expect(exitSpy).toHaveBeenCalledWith(1)
  })

  it('exits with non-zero when SUPABASE_URL is not a valid URL', async () => {
    vi.stubEnv('SUPABASE_URL', 'not-a-url')
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called')
    }) as (code?: string | number | null) => never)
    vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(runApproveUser(['--email', 'user@example.com'])).rejects.toThrow()
    expect(exitSpy).toHaveBeenCalledWith(1)
  })

  it('exits with non-zero when SUPABASE_URL is an unreachable host', async () => {
    vi.stubEnv('SUPABASE_URL', 'http://test.supabase.co')
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')))
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called')
    }) as (code?: string | number | null) => never)
    vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(runApproveUser(['--email', 'user@example.com'])).rejects.toThrow()
    expect(exitSpy).toHaveBeenCalledWith(1)
  })
})

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('admin approve-user — happy path', () => {
  const USER_UUID = '11111111-2222-3333-4444-555555555555'
  const RESOURCE_UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

  it('approves a user and logs success', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})

    let callIndex = 0
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => {
      callIndex++
      if (callIndex === 1) {
        // listUsers response
        return Promise.resolve(mockResponse(200, {
          users: [{ id: USER_UUID, email: 'user@example.com' }],
        }))
      }
      if (callIndex === 2) {
        // findResource response
        return Promise.resolve(mockResponse(200, [{
          id: RESOURCE_UUID,
          name: 'user:user',
          config: { status: 'pending' },
        }]))
      }
      // PATCH response
      return Promise.resolve(mockResponse(200, [{
        id: RESOURCE_UUID,
        config: { status: 'approved' },
      }]))
    }))

    await runApproveUser(['--email', 'user@example.com'])

    const consoleSpy = vi.mocked(console.log)
    const allLogs = consoleSpy.mock.calls.map(c => String(c[0])).join('\n')
    expect(allLogs).toContain('Success')
    expect(allLogs).toContain(RESOURCE_UUID)
  })

  it('exits cleanly if user is already approved', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})

    let callIndex = 0
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => {
      callIndex++
      if (callIndex === 1) {
        return Promise.resolve(mockResponse(200, {
          users: [{ id: USER_UUID, email: 'user@example.com' }],
        }))
      }
      return Promise.resolve(mockResponse(200, [{
        id: RESOURCE_UUID,
        name: 'user:user',
        config: { status: 'approved' },
      }]))
    }))

    await runApproveUser(['--email', 'user@example.com'])

    const consoleSpy = vi.mocked(console.log)
    const allLogs = consoleSpy.mock.calls.map(c => String(c[0])).join('\n')
    expect(allLogs).toMatch(/already approved/i)
  })
})

// ---------------------------------------------------------------------------
// Error paths
// ---------------------------------------------------------------------------

describe('admin approve-user — error paths', () => {
  const USER_UUID = '11111111-2222-3333-4444-555555555555'
  const RESOURCE_UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

  it('exits with 1 when no auth user is found', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called')
    }) as (code?: string | number | null) => never)

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      mockResponse(200, { users: [] })
    ))

    await expect(runApproveUser(['--email', 'nobody@example.com'])).rejects.toThrow()
    expect(exitSpy).toHaveBeenCalledWith(1)
  })

  it('exits with 1 when multiple auth users match', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called')
    }) as (code?: string | number | null) => never)

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      mockResponse(200, {
        users: [
          { id: USER_UUID, email: 'user@example.com' },
          { id: '22222222-3333-4444-5555-666666666666', email: 'user@example.com' },
        ],
      })
    ))

    await expect(runApproveUser(['--email', 'user@example.com'])).rejects.toThrow()
    expect(exitSpy).toHaveBeenCalledWith(1)
    const errors = vi.mocked(console.error).mock.calls.map(c => String(c[0])).join('\n')
    expect(errors).toMatch(/multiple/i)
  })

  it('exits with 1 when no user resource row is found', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called')
    }) as (code?: string | number | null) => never)

    let callIndex = 0
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => {
      callIndex++
      if (callIndex === 1) {
        return Promise.resolve(mockResponse(200, {
          users: [{ id: USER_UUID, email: 'user@example.com' }],
        }))
      }
      return Promise.resolve(mockResponse(200, []))
    }))

    await expect(runApproveUser(['--email', 'user@example.com'])).rejects.toThrow()
    expect(exitSpy).toHaveBeenCalledWith(1)
  })

  it('exits with 1 when listUsers HTTP request fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called')
    }) as (code?: string | number | null) => never)

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse(500, { error: 'server error' })))

    await expect(runApproveUser(['--email', 'user@example.com'])).rejects.toThrow()
    expect(exitSpy).toHaveBeenCalledWith(1)
  })

  it('exits with 1 when the PATCH returns unexpected status', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called')
    }) as (code?: string | number | null) => never)

    let callIndex = 0
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => {
      callIndex++
      if (callIndex === 1) {
        return Promise.resolve(mockResponse(200, {
          users: [{ id: USER_UUID, email: 'user@example.com' }],
        }))
      }
      if (callIndex === 2) {
        return Promise.resolve(mockResponse(200, [{
          id: RESOURCE_UUID,
          name: 'user:user',
          config: { status: 'pending' },
        }]))
      }
      // PATCH response returns wrong status
      return Promise.resolve(mockResponse(200, [{ id: RESOURCE_UUID, config: { status: 'pending' } }]))
    }))

    await expect(runApproveUser(['--email', 'user@example.com'])).rejects.toThrow()
    expect(exitSpy).toHaveBeenCalledWith(1)
    const errors = vi.mocked(console.error).mock.calls.map(c => String(c[0])).join('\n')
    expect(errors).toMatch(/not "approved"/i)
  })
})
