import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// ---------------------------------------------------------------------------
// Mock helpers module so getApiBaseUrl() returns a controlled base URL
// ---------------------------------------------------------------------------
vi.mock('../lib/helpers.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/helpers.js')>()
  return {
    ...actual,
    getApiBaseUrl: vi.fn().mockReturnValue('https://bff.test'),
  }
})

import {
  provisionSandbox,
  deprovisionSandbox,
  getSandboxStatus,
  getSshAccess,
  BffNotApprovedError,
  BffSandboxLimitError,
  BffUnreachableError,
  BffSandboxNotFoundError,
} from '../lib/sandbox-bff-client.js'
import { getApiBaseUrl } from '../lib/helpers.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_JWT = 'header.payload.sig'

/** Build a mock Response object */
function mockResponse(status: number, body: unknown): Response {
  const serialized = JSON.stringify(body)
  return {
    ok: status >= 200 && status < 300,
    status,
    url: `https://bff.test/api/sandbox/test`,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(serialized),
  } as unknown as Response
}

/** Stub global fetch to return the given Response */
function stubFetch(res: Response): ReturnType<typeof vi.fn> {
  const mock = vi.fn().mockResolvedValue(res)
  vi.stubGlobal('fetch', mock)
  return mock
}

/** Stub global fetch to throw a network error */
function stubFetchNetworkError(message = 'ECONNREFUSED'): void {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error(message)))
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.unstubAllGlobals()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetAllMocks()
  // Re-apply the base URL mock after resetAllMocks() clears it
  vi.mocked(getApiBaseUrl).mockReturnValue('https://bff.test')
})

// ---------------------------------------------------------------------------
// provisionSandbox
// ---------------------------------------------------------------------------

describe('provisionSandbox', () => {
  it('200 → returns { status, resourceId }', async () => {
    const payload = { status: 'provisioning', resourceId: 'res-abc' }
    const fetchMock = stubFetch(mockResponse(200, payload))

    const result = await provisionSandbox(TEST_JWT, 'ssh-ed25519 AAAA...')

    expect(result).toEqual(payload)
    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://bff.test/api/sandbox/provision')
    expect(opts.method).toBe('POST')
  })

  it('403 → throws BffNotApprovedError', async () => {
    stubFetch(mockResponse(403, { error: 'forbidden' }))

    await expect(provisionSandbox(TEST_JWT, 'ssh-ed25519 AAAA...')).rejects.toThrow(BffNotApprovedError)
  })

  it('409 → throws BffSandboxLimitError', async () => {
    stubFetch(mockResponse(409, { error: 'limit reached' }))

    await expect(provisionSandbox(TEST_JWT, 'ssh-ed25519 AAAA...')).rejects.toThrow(BffSandboxLimitError)
  })

  it('network failure → throws BffUnreachableError', async () => {
    stubFetchNetworkError()

    await expect(provisionSandbox(TEST_JWT, 'ssh-ed25519 AAAA...')).rejects.toThrow(BffUnreachableError)
  })

  it('502 on first attempt → retries once and returns success on second', async () => {
    const payload = { status: 'provisioning', resourceId: 'res-retry' }
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(mockResponse(502, { error: 'bad gateway' }))
      .mockResolvedValueOnce(mockResponse(200, payload))
    vi.stubGlobal('fetch', fetchMock)

    const result = await provisionSandbox(TEST_JWT, 'ssh-ed25519 AAAA...')

    expect(result).toEqual(payload)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  }, 10_000)

  it('503 on first attempt → retries once and returns success on second', async () => {
    const payload = { status: 'provisioning', resourceId: 'res-retry-503' }
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(mockResponse(503, { error: 'service unavailable' }))
      .mockResolvedValueOnce(mockResponse(200, payload))
    vi.stubGlobal('fetch', fetchMock)

    const result = await provisionSandbox(TEST_JWT, 'ssh-ed25519 AAAA...')

    expect(result).toEqual(payload)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  }, 10_000)

  it('504 on first attempt → retries once and returns success on second', async () => {
    const payload = { status: 'provisioning', resourceId: 'res-retry-504' }
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(mockResponse(504, { error: 'gateway timeout' }))
      .mockResolvedValueOnce(mockResponse(200, payload))
    vi.stubGlobal('fetch', fetchMock)

    const result = await provisionSandbox(TEST_JWT, 'ssh-ed25519 AAAA...')

    expect(result).toEqual(payload)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  }, 10_000)

  it('502 on both attempts → throws generic error', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(mockResponse(502, { error: 'error 1' }))
      .mockResolvedValueOnce(mockResponse(502, { error: 'error 2' }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(provisionSandbox(TEST_JWT, 'ssh-ed25519 AAAA...')).rejects.toThrow(/Unexpected HTTP 502/)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  }, 10_000)

  it('500 on first attempt → no retry, throws immediately (not idempotent-safe)', async () => {
    const fetchMock = stubFetch(mockResponse(500, { error: 'internal server error' }))

    await expect(provisionSandbox(TEST_JWT, 'ssh-ed25519 AAAA...')).rejects.toThrow(/Unexpected HTTP 500/)
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('502 on first attempt, network error on retry → throws BffUnreachableError', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(mockResponse(502, { error: 'bad gateway' }))
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
    vi.stubGlobal('fetch', fetchMock)

    await expect(provisionSandbox(TEST_JWT, 'ssh-ed25519 AAAA...')).rejects.toThrow(BffUnreachableError)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  }, 10_000)

  it('400 on first attempt → no retry, throws generic error', async () => {
    const fetchMock = stubFetch(mockResponse(400, { error: 'bad request' }))

    await expect(provisionSandbox(TEST_JWT, 'ssh-ed25519 AAAA...')).rejects.toThrow(/Unexpected HTTP 400/)
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('sends Authorization: Bearer <jwt> header', async () => {
    const payload = { status: 'provisioning', resourceId: 'res-abc' }
    const fetchMock = stubFetch(mockResponse(200, payload))

    await provisionSandbox(TEST_JWT, 'ssh-ed25519 AAAA...')

    const [, opts] = fetchMock.mock.calls[0] as [string, RequestInit]
    const headers = opts.headers as Record<string, string>
    expect(headers['Authorization']).toBe(`Bearer ${TEST_JWT}`)
  })

  it('sends Content-Type: application/json header', async () => {
    const payload = { status: 'provisioning', resourceId: 'res-abc' }
    const fetchMock = stubFetch(mockResponse(200, payload))

    await provisionSandbox(TEST_JWT, 'ssh-ed25519 AAAA...')

    const [, opts] = fetchMock.mock.calls[0] as [string, RequestInit]
    const headers = opts.headers as Record<string, string>
    expect(headers['Content-Type']).toBe('application/json')
  })
})

// ---------------------------------------------------------------------------
// deprovisionSandbox
// ---------------------------------------------------------------------------

describe('deprovisionSandbox', () => {
  it('200 → returns { deleted: true }', async () => {
    const payload = { deleted: true }
    const fetchMock = stubFetch(mockResponse(200, payload))

    const result = await deprovisionSandbox(TEST_JWT)

    expect(result).toEqual(payload)
    const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://bff.test/api/sandbox/deprovision')
    expect(opts.method).toBe('DELETE')
  })

  it('network failure → throws BffUnreachableError', async () => {
    stubFetchNetworkError()

    await expect(deprovisionSandbox(TEST_JWT)).rejects.toThrow(BffUnreachableError)
  })

  it('sends Authorization: Bearer <jwt> header', async () => {
    const payload = { deleted: true }
    const fetchMock = stubFetch(mockResponse(200, payload))

    await deprovisionSandbox(TEST_JWT)

    const [, opts] = fetchMock.mock.calls[0] as [string, RequestInit]
    const headers = opts.headers as Record<string, string>
    expect(headers['Authorization']).toBe(`Bearer ${TEST_JWT}`)
  })
})

// ---------------------------------------------------------------------------
// getSandboxStatus
// ---------------------------------------------------------------------------

describe('getSandboxStatus', () => {
  it('200 → returns { status, ip }', async () => {
    const payload = { status: 'active', ip: '1.2.3.4' }
    const fetchMock = stubFetch(mockResponse(200, payload))

    const result = await getSandboxStatus(TEST_JWT)

    expect(result).toEqual(payload)
    const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://bff.test/api/sandbox/status')
    expect(opts.method).toBe('GET')
  })

  it('200 → returns { status } without ip when ip is absent', async () => {
    const payload = { status: 'provisioning' }
    stubFetch(mockResponse(200, payload))

    const result = await getSandboxStatus(TEST_JWT)

    expect(result.status).toBe('provisioning')
    expect(result.ip).toBeUndefined()
  })

  it('404 → throws BffSandboxNotFoundError', async () => {
    stubFetch(mockResponse(404, { error: 'not found' }))

    await expect(getSandboxStatus(TEST_JWT)).rejects.toThrow(BffSandboxNotFoundError)
  })

  it('network failure → throws BffUnreachableError', async () => {
    stubFetchNetworkError()

    await expect(getSandboxStatus(TEST_JWT)).rejects.toThrow(BffUnreachableError)
  })

  it('sends Authorization: Bearer <jwt> header', async () => {
    const fetchMock = stubFetch(mockResponse(200, { status: 'active' }))

    await getSandboxStatus(TEST_JWT)

    const [, opts] = fetchMock.mock.calls[0] as [string, RequestInit]
    const headers = opts.headers as Record<string, string>
    expect(headers['Authorization']).toBe(`Bearer ${TEST_JWT}`)
  })
})

// ---------------------------------------------------------------------------
// getSshAccess
// ---------------------------------------------------------------------------

describe('getSshAccess', () => {
  it('200 → returns { allowed, ip, keyPath }', async () => {
    const payload = { allowed: true, ip: '5.6.7.8', keyPath: '/home/user/.config/duoidal/sandboxes/srv/id_ed25519' }
    const fetchMock = stubFetch(mockResponse(200, payload))

    const result = await getSshAccess(TEST_JWT)

    expect(result).toEqual(payload)
    const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://bff.test/api/sandbox/ssh-access')
    expect(opts.method).toBe('GET')
  })

  it('404 → throws BffSandboxNotFoundError', async () => {
    stubFetch(mockResponse(404, { error: 'not found' }))

    await expect(getSshAccess(TEST_JWT)).rejects.toThrow(BffSandboxNotFoundError)
  })

  it('network failure → throws BffUnreachableError', async () => {
    stubFetchNetworkError()

    await expect(getSshAccess(TEST_JWT)).rejects.toThrow(BffUnreachableError)
  })

  it('sends Authorization: Bearer <jwt> header', async () => {
    const payload = { allowed: true, ip: '5.6.7.8', keyPath: '/key' }
    const fetchMock = stubFetch(mockResponse(200, payload))

    await getSshAccess(TEST_JWT)

    const [, opts] = fetchMock.mock.calls[0] as [string, RequestInit]
    const headers = opts.headers as Record<string, string>
    expect(headers['Authorization']).toBe(`Bearer ${TEST_JWT}`)
  })
})

// ---------------------------------------------------------------------------
// getApiBaseUrl integration — URL derived from env var
// ---------------------------------------------------------------------------

describe('URL sourced from getApiBaseUrl()', () => {
  it('uses the base URL returned by getApiBaseUrl()', async () => {
    // The mock in vi.mock at the top returns 'https://bff.test'
    const fetchMock = stubFetch(mockResponse(200, { status: 'active' }))

    await getSandboxStatus(TEST_JWT)

    const [url] = fetchMock.mock.calls[0] as [string]
    expect(url).toContain('https://bff.test')
  })
})
