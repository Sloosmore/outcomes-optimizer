import { createPrivateKey } from 'crypto'
import { SignJWT } from 'jose'
import type { SourceControlProvider } from './index.js'

export interface GitHubAppAdapterOptions {
  appId: string
  privateKey: string
  installationId: string
}

export class GitHubAppAdapter implements SourceControlProvider {
  private readonly appId: string
  private readonly privateKey: string
  private readonly installationId: string

  constructor(opts: GitHubAppAdapterOptions) {
    this.appId = opts.appId
    this.privateKey = opts.privateKey
    this.installationId = opts.installationId
  }

  private async signJwt(): Promise<string> {
    // createPrivateKey handles both PKCS#8 and PKCS#1 (RSA PRIVATE KEY) formats
    const key = createPrivateKey(this.privateKey)
    const now = Math.floor(Date.now() / 1000)
    return new SignJWT({ iss: this.appId })
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuedAt(now - 60)
      .setExpirationTime(now + 300)
      .sign(key)
  }

  private async getInstallationToken(): Promise<string> {
    const jwt = await this.signJwt()
    const resp = await fetch(
      `https://api.github.com/app/installations/${this.installationId}/access_tokens`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${jwt}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'duoidal-sandbox',
        },
      }
    )

    if (!resp.ok) {
      const body = await resp.text()
      throw new Error(
        `GitHub API error ${resp.status} getting installation token: ${body}`
      )
    }

    const data = (await resp.json()) as { token: string }
    return data.token
  }

  async getCloneUrl(repo: { owner: string; name: string }): Promise<string> {
    const token = await this.getInstallationToken()
    return `https://x-access-token:${token}@github.com/${repo.owner}/${repo.name}.git`
  }
}
