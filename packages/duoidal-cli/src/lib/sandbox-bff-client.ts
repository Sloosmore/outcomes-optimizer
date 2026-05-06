/**
 * Typed BFF client for sandbox API calls.
 *
 * All functions read the base URL from getApiBaseUrl() and authenticate
 * via Bearer JWT. Network errors are wrapped in BffUnreachableError;
 * HTTP 403 → BffNotApprovedError; HTTP 409 → BffSandboxLimitError.
 */

import { getApiBaseUrl } from './helpers.js'
import { PROVISION_RETRY_DELAY_MS } from './config.js'

// ---------------------------------------------------------------------------
// Error classes
// ---------------------------------------------------------------------------

export class BffNotApprovedError extends Error {
  constructor(message = 'Not approved: HTTP 403') {
    super(message)
    this.name = 'BffNotApprovedError'
  }
}

export class BffSandboxLimitError extends Error {
  constructor(message = 'Sandbox limit reached: HTTP 409') {
    super(message)
    this.name = 'BffSandboxLimitError'
  }
}

export class BffUnreachableError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message)
    this.name = 'BffUnreachableError'
    if (cause !== undefined) {
      this.cause = cause
    }
  }
}

export class BffSandboxNotFoundError extends Error {
  constructor(message = 'Sandbox not found: HTTP 404') {
    super(message)
    this.name = 'BffSandboxNotFoundError'
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function authHeaders(jwt: string): Record<string, string> {
  return {
    Authorization: `Bearer ${jwt}`,
  }
}

function jsonHeaders(jwt: string): Record<string, string> {
  return {
    ...authHeaders(jwt),
    'Content-Type': 'application/json',
  }
}

async function handleResponse(res: Response): Promise<unknown> {
  if (res.ok) {
    const text = await res.text()
    try {
      return JSON.parse(text)
    } catch {
      throw new Error(`Non-JSON response from ${res.url}: ${text.slice(0, 200)}`)
    }
  }
  if (res.status === 403) {
    throw new BffNotApprovedError(`Not approved: HTTP 403 from ${res.url}`)
  }
  if (res.status === 404) {
    throw new BffSandboxNotFoundError(`Sandbox not found: HTTP 404 from ${res.url}`)
  }
  if (res.status === 409) {
    throw new BffSandboxLimitError(`Sandbox limit reached: HTTP 409 from ${res.url}`)
  }
  const body = await res.text().catch(() => '(unreadable)')
  throw new Error(`Unexpected HTTP ${res.status} from ${res.url}: ${body.slice(0, 200)}`)
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function provisionSandbox(
  jwt: string,
  publicKey: string
): Promise<{ status: string; resourceId: string }> {
  const url = `${getApiBaseUrl()}/api/sandbox/provision`
  const doFetch = async (): Promise<Response> => {
    try {
      return await fetch(url, {
        method: 'POST',
        headers: jsonHeaders(jwt),
        body: JSON.stringify({ publicKey }),
      })
    } catch (err) {
      throw new BffUnreachableError(`Cannot reach BFF at ${url}`, err)
    }
  }
  let res = await doFetch()
  // Only retry on 502/503/504 (gateway unreachable / service unavailable / upstream timeout).
  // These indicate the BFF app never handled the request, so a POST retry is safe.
  // Do NOT retry on 500 — a 500 may mean the BFF processed the request (and created the VM)
  // before crashing to write the response, which would produce a duplicate orphaned resource.
  if (res.status === 502 || res.status === 503 || res.status === 504) {
    const firstStatus = res.status
    const firstBody = await res.text().catch(() => '(unreadable)')
    console.warn(`provisionSandbox: HTTP ${firstStatus} on first attempt: ${firstBody.slice(0, 200)} - retrying in ${PROVISION_RETRY_DELAY_MS / 1000}s`)
    await new Promise(r => setTimeout(r, PROVISION_RETRY_DELAY_MS))
    res = await doFetch()
    if (res.status >= 500) {
      console.warn(`provisionSandbox: HTTP ${res.status} on retry (first attempt was HTTP ${firstStatus}) - giving up`)
    }
  }
  return handleResponse(res) as Promise<{ status: string; resourceId: string }>
}

export async function deprovisionSandbox(
  jwt: string
): Promise<{ deleted: boolean }> {
  const url = `${getApiBaseUrl()}/api/sandbox/deprovision`
  let res: Response
  try {
    res = await fetch(url, {
      method: 'DELETE',
      headers: authHeaders(jwt),
    })
  } catch (err) {
    throw new BffUnreachableError(`Cannot reach BFF at ${url}`, err)
  }
  return handleResponse(res) as Promise<{ deleted: boolean }>
}

export async function getSandboxStatus(
  jwt: string
): Promise<{ status: string; ip?: string }> {
  const url = `${getApiBaseUrl()}/api/sandbox/status`
  let res: Response
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: authHeaders(jwt),
    })
  } catch (err) {
    throw new BffUnreachableError(`Cannot reach BFF at ${url}`, err)
  }
  return handleResponse(res) as Promise<{ status: string; ip?: string }>
}

export async function getSshAccess(
  jwt: string
): Promise<{ allowed: boolean; ip: string; keyPath: string }> {
  const url = `${getApiBaseUrl()}/api/sandbox/ssh-access`
  let res: Response
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: authHeaders(jwt),
    })
  } catch (err) {
    throw new BffUnreachableError(`Cannot reach BFF at ${url}`, err)
  }
  return handleResponse(res) as Promise<{ allowed: boolean; ip: string; keyPath: string }>
}

export async function getRepoCloneUrl(jwt: string, repo: string): Promise<{ cloneUrl: string }> {
  const base = getApiBaseUrl()
  const url = `${base}/api/sandbox/repo-clone`
  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: jsonHeaders(jwt),
      body: JSON.stringify({ repo }),
    })
  } catch (err) {
    throw new BffUnreachableError(`Cannot reach provisioning service: ${url}`, err)
  }
  return handleResponse(res) as Promise<{ cloneUrl: string }>
}
