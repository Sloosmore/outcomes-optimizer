import { describe, it, expect } from 'vitest'
import { createPrivateKey } from 'crypto'
import { SignJWT } from 'jose'
import { GitHubAppAdapter } from './github.js'
import { PublicAdapter } from './public.js'

// Gate: requires explicit opt-in regardless of credential presence
const RUN_INTEGRATION = !!process.env.RUN_INTEGRATION

// ─── Unit tests (always run) ─────────────────────────────────────────────────

describe('PublicAdapter', () => {
  it('returns plain https clone URL', async () => {
    const adapter = new PublicAdapter()
    const url = await adapter.getCloneUrl({ owner: 'test', name: 'repo' })
    expect(url).toBe('https://github.com/test/repo.git')
  })

  it('handles different owners and repo names', async () => {
    const adapter = new PublicAdapter()
    const url = await adapter.getCloneUrl({
      owner: 'test-org',
      name: 'test-sandbox-repo',
    })
    expect(url).toBe('https://github.com/test-org/test-sandbox-repo.git')
  })
})

describe('GitHubAppAdapter — constructor', () => {
  it('is importable and constructible', () => {
    const adapter = new GitHubAppAdapter({
      appId: 'test-app-id',
      privateKey: '--- placeholder ---',
      installationId: '12345',
    })
    expect(adapter).toBeDefined()
    expect(typeof adapter.getCloneUrl).toBe('function')
  })
})

// ─── Integration tests (require RUN_INTEGRATION=true) ────────────────────────

describe.skipIf(!RUN_INTEGRATION)('GitHubAppAdapter — real GitHub API (integration)', () => {
  const appId = process.env.GITHUB_APP_ID!
  const privateKey = process.env.GITHUB_APP_PRIVATE_KEY!

  it('signs JWT and calls GET /app/installations — HTTP 200 proves JWT signing works', async () => {
    // Sign a JWT with the real private key
    // createPrivateKey handles both PKCS#8 (BEGIN PRIVATE KEY) and PKCS#1 (BEGIN RSA PRIVATE KEY)
    const key = createPrivateKey(privateKey)
    const now = Math.floor(Date.now() / 1000)
    const jwt = await new SignJWT({ iss: appId })
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuedAt(now - 60)
      .setExpirationTime(now + 300)
      .sign(key)

    // Call the real GitHub API — 200 proves JWT signing is valid
    const resp = await fetch('https://api.github.com/app/installations', {
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'duoidal-sandbox-test',
      },
    })

    // HTTP 200 = JWT was accepted by GitHub — proves JWT signing with real private key works
    // HTTP 401 = JWT rejected — wrong key or malformed signing
    expect(resp.status).toBe(200)
    const installations = (await resp.json()) as Array<{
      id: number
      account: { login: string }
    }>
    expect(Array.isArray(installations)).toBe(true)
    console.log(
      `JWT signing verified — GET /app/installations returned 200 with ${installations.length} installation(s)`
    )
  })

  it('exchanges installation token and constructs authenticated clone URL', async () => {
    // Sign JWT to list installations
    const key = createPrivateKey(privateKey)
    const now = Math.floor(Date.now() / 1000)
    const jwt = await new SignJWT({ iss: appId })
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuedAt(now - 60)
      .setExpirationTime(now + 300)
      .sign(key)

    const resp = await fetch('https://api.github.com/app/installations', {
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'duoidal-sandbox-test',
      },
    })
    const installations = (await resp.json()) as Array<{
      id: number
      account: { login: string }
    }>

    const testInstallation = installations.find(
      (i) => i.account?.login?.toLowerCase() === 'test-org'
    )

    // Resolve installation ID: prefer API response, fall back to env var, throw if neither available
    let installationId: string
    if (testInstallation) {
      installationId = String(testInstallation.id)
      console.log(`Found installation via API: id=${installationId}`)
    } else if (process.env.GITHUB_INSTALL_ID) {
      installationId = process.env.GITHUB_INSTALL_ID
      console.log(
        `Installation not found via API (${installations.length} total) — using GITHUB_INSTALL_ID=${installationId}`
      )
    } else {
      throw new Error(
        `No installation for test-org found via API (${installations.length} total) ` +
          `and GITHUB_INSTALL_ID env var is not set. Cannot proceed with token exchange.`
      )
    }

    const adapter = new GitHubAppAdapter({
      appId,
      privateKey,
      installationId,
    })

    const url = await adapter.getCloneUrl({
      owner: 'test-org',
      name: 'test-sandbox-repo',
    })

    expect(url).toMatch(/^https:\/\/x-access-token:[a-zA-Z0-9_]+@github\.com\//)
    expect(url).toContain('github.com/test-org/test-sandbox-repo')

    console.log(
      'Clone URL constructed:',
      url.replace(/x-access-token:[^@]+/, 'x-access-token:***')
    )
  })
})
