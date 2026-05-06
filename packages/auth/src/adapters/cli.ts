import type { SupabaseClient } from '@supabase/supabase-js'
import type { CLIAuthAdapter as ICLIAuthAdapter, AuthToken } from './types.js'
import { AuthError } from './access-code.js'
import { AccessCodeAuthAdapter } from './access-code.js'

export interface CLIAuthAdapterOptions {
  /** Port to listen on for OAuth callback. Defaults to random available port. */
  callbackPort?: number
  /** Timeout in ms for OAuth/app flows. Defaults to 60000. Override in tests. */
  oauthTimeoutMs?: number
}

export class CLIAuthAdapter implements ICLIAuthAdapter {
  readonly type = 'cli' as const
  private token: AuthToken | null = null
  private readonly callbackPort: number
  private readonly oauthTimeoutMs: number

  constructor(
    private readonly client: SupabaseClient,
    options: CLIAuthAdapterOptions = {}
  ) {
    this.callbackPort = options.callbackPort ?? 0 // 0 = random port assigned by OS
    this.oauthTimeoutMs = options.oauthTimeoutMs ?? 60_000
  }

  async getToken(): Promise<AuthToken> {
    if (!this.token) {
      throw new AuthError(
        'Not authenticated — call startOAuthFlow() or loginWithAccessCode() first',
        'NOT_AUTHENTICATED'
      )
    }
    return this.token
  }

  async isAuthenticated(): Promise<boolean> {
    if (!this.token) return false
    if (this.token.expiresAt !== undefined && Math.floor(Date.now() / 1000) >= this.token.expiresAt) {
      return false
    }
    return true
  }

  async logout(): Promise<void> {
    this.token = null
    await this.client.auth.signOut()
  }

  async startOAuthFlow(): Promise<AuthToken> {
    // Dynamic imports to keep Node.js built-ins tree-shakeable
    const { createServer } = await import('http')
    const { URL: NodeURL } = await import('url')

    return new Promise((resolve, reject) => {
      let settled = false
      const settle = (fn: () => void) => { if (!settled) { settled = true; clearTimeout(timeoutHandle); fn() } }

      const timeoutHandle = setTimeout(() => {
        settle(() => {
          server.close()
          reject(new AuthError(
            'OAuth callback timed out after 60s. Use --token or --with-token for headless environments.',
            'INVALID_CODE'
          ))
        })
      }, this.oauthTimeoutMs)

      const server = createServer(async (req, res) => {
        if (!req.url) { res.end(); return }
        const url = new NodeURL(req.url, `http://localhost`)

        // Handle POST with direct token data (from JS hash extraction)
        if (req.method === 'POST' && url.pathname === '/callback') {
          const MAX_BODY = 8192
          let body = ''
          let oversized = false
          req.on('data', (chunk: Buffer) => {
            body += chunk.toString()
            if (body.length > MAX_BODY) {
              oversized = true
              res.writeHead(413)
              res.end(JSON.stringify({ error: 'payload too large' }))
              req.destroy()
            }
          })
          req.on('end', () => {
            if (oversized) return
            try {
              const data = JSON.parse(body)
              const { access_token, refresh_token, expires_at } = data
              if (typeof access_token !== 'string' || access_token.length === 0) {
                res.writeHead(400)
                res.end(JSON.stringify({ error: 'access_token must be a non-empty string' }))
                return
              }
              if (refresh_token !== undefined && typeof refresh_token !== 'string') {
                res.writeHead(400)
                res.end(JSON.stringify({ error: 'refresh_token must be a string if provided' }))
                return
              }
              if (expires_at !== undefined && typeof expires_at !== 'number') {
                res.writeHead(400)
                res.end(JSON.stringify({ error: 'expires_at must be a number if provided' }))
                return
              }
              // Only allow requests from the same origin (the inline HTML page)
              res.writeHead(200, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ ok: true }))
              settle(() => {
                server.close()
                this.token = { accessToken: access_token, refreshToken: refresh_token, expiresAt: expires_at }
                resolve(this.token)
              })
            } catch (e) {
              settle(() => reject(e))
            }
          })
          return
        }

        const code = url.searchParams.get('code')
        if (code) {
          // PKCE flow: exchange code for session
          res.writeHead(200, { 'Content-Type': 'text/html' })
          res.end('<html><body><h1>Authenticated! You can close this tab.</h1></body></html>')
          settle(() => server.close())
          try {
            const { data, error } = await this.client.auth.exchangeCodeForSession(code)
            if (error || !data.session) {
              settle(() => reject(new AuthError(error?.message ?? 'OAuth exchange failed', 'INVALID_CODE')))
              return
            }
            this.token = {
              accessToken: data.session.access_token,
              refreshToken: data.session.refresh_token ?? undefined,
              expiresAt: data.session.expires_at ?? undefined,
            }
            settle(() => resolve(this.token!))
          } catch (e) {
            settle(() => reject(e))
          }
          return
        }

        // No code in query params — serve HTML+JS to extract from hash fragment
        const callbackPort = (server.address() as import('net').AddressInfo).port
        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end(`<html><body>
<p id="msg">Processing authentication...</p>
<script>
const hash = window.location.hash.substring(1);
const params = new URLSearchParams(hash);
const access_token = params.get('access_token');
const refresh_token = params.get('refresh_token');
const expires_at = params.get('expires_at');
if (access_token) {
  fetch('http://localhost:${callbackPort}/callback', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({ access_token, refresh_token, expires_at: expires_at ? parseInt(expires_at) : undefined })
  }).then(r => r.json()).then(d => {
    document.getElementById('msg').textContent = 'Authenticated! You can close this tab.';
  }).catch(e => {
    document.getElementById('msg').textContent = 'Error: ' + e.message;
  });
} else {
  document.getElementById('msg').textContent = 'Authentication failed - no token in URL. Please try again.';
}
</script>
</body></html>`)
      })

      server.listen(this.callbackPort, async () => {
        const address = server.address()
        if (!address || typeof address === 'string') {
          settle(() => reject(new AuthError('Failed to start callback server', 'INVALID_CODE')))
          return
        }
        const port = address.port
        const callbackUrl = `http://localhost:${port}/callback`

        // If service key + test email are set, prefer magic link (bypasses browser OAuth device checks)
        const serviceKey = process.env['SUPABASE_SERVICE_KEY']
        const supabaseUrl = process.env['SUPABASE_URL'] ?? ''
        const testEmail = process.env['DUOIDAL_TEST_EMAIL']
        if (serviceKey && supabaseUrl && testEmail) {
          try {
            const { createClient } = await import('@supabase/supabase-js')
            const adminClient = createClient(supabaseUrl, serviceKey)
            const { data: linkData, error: linkError } = await adminClient.auth.admin.generateLink({
              type: 'magiclink',
              email: testEmail,
              options: { redirectTo: callbackUrl }
            })
            if (!linkError && linkData?.properties?.action_link) {
              process.stdout.write(`OAUTH_URL:${linkData.properties.action_link}\n`)
              return
            }
          } catch (err) {
            // Log for debuggability, then fall through to GitHub OAuth
            if (process.env['DEBUG']) console.error('Magic link generation failed:', err)
          }
        }

        // Fall back to GitHub OAuth
        const { data: oauthData, error: oauthError } = await this.client.auth.signInWithOAuth({
          provider: 'github',
          options: { redirectTo: callbackUrl, skipBrowserRedirect: true }
        })

        if (!oauthError && oauthData.url) {
          process.stdout.write(`OAUTH_URL:${oauthData.url}\n`)
          return
        }

        settle(() => {
          server.close()
          reject(new AuthError(oauthError?.message ?? 'Failed to generate OAuth URL', 'INVALID_CODE'))
        })
      })

      server.on('error', (err) => {
        settle(() => reject(new AuthError(`Server error: ${err.message}`, 'INVALID_CODE')))
      })
    })
  }

  async startAppFlow(appUrl: string): Promise<AuthToken> {
    const { createServer } = await import('http')
    const { URL: NodeURL } = await import('url')

    // Validate appUrl before starting the server
    let appOrigin: string
    try {
      appOrigin = new NodeURL(appUrl).origin
    } catch {
      throw new AuthError(`Invalid appUrl: ${appUrl}`, 'INVALID_CODE')
    }

    return new Promise((resolve, reject) => {
      let settled = false
      const settle = (fn: () => void) => { if (!settled) { settled = true; clearTimeout(timeoutHandle); fn() } }

      const timeoutHandle = setTimeout(() => {
        settle(() => {
          server.close()
          reject(new AuthError(
            'App auth callback timed out. Use --token or --with-token for headless environments.',
            'INVALID_CODE'
          ))
        })
      }, this.oauthTimeoutMs)

      const server = createServer((req, res) => {
        if (!req.url) { res.end(); return }
        const url = new NodeURL(req.url, `http://localhost`)

        // CORS: restrict to the known app origin — prevents arbitrary pages from injecting tokens
        res.setHeader('Access-Control-Allow-Origin', appOrigin)
        res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

        // Handle CORS preflight
        if (req.method === 'OPTIONS') {
          res.writeHead(204)
          res.end()
          return
        }

        if (req.method === 'POST' && url.pathname === '/callback') {
          const MAX_BODY = 8192
          let body = ''
          let oversized = false
          req.on('data', (chunk: Buffer) => {
            body += chunk.toString()
            if (body.length > MAX_BODY) {
              oversized = true
              res.writeHead(413)
              res.end(JSON.stringify({ error: 'payload too large' }))
              req.destroy()
            }
          })
          req.on('end', () => {
            if (oversized) return
            try {
              const data = JSON.parse(body)
              const { access_token, refresh_token, expires_at } = data
              if (typeof access_token !== 'string' || access_token.length === 0) {
                res.writeHead(400)
                res.end(JSON.stringify({ error: 'access_token must be a non-empty string' }))
                return
              }
              if (refresh_token !== undefined && typeof refresh_token !== 'string') {
                res.writeHead(400)
                res.end(JSON.stringify({ error: 'refresh_token must be a string if provided' }))
                return
              }
              if (expires_at !== undefined && typeof expires_at !== 'number') {
                res.writeHead(400)
                res.end(JSON.stringify({ error: 'expires_at must be a number if provided' }))
                return
              }
              res.writeHead(200, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ ok: true }))
              settle(() => {
                server.close()
                this.token = { accessToken: access_token, refreshToken: refresh_token, expiresAt: expires_at }
                resolve(this.token)
              })
            } catch (e) {
              settle(() => reject(e))
            }
          })
          return
        }

        res.writeHead(404)
        res.end()
      })

      server.listen(this.callbackPort, () => {
        const address = server.address()
        if (!address || typeof address === 'string') {
          settle(() => reject(new AuthError('Failed to start callback server', 'INVALID_CODE')))
          return
        }
        const port = address.port
        const callbackUrl = `http://localhost:${port}/callback`
        const redirectUrl = `${appUrl}/cli-auth?redirect=${encodeURIComponent(callbackUrl)}`
        process.stdout.write(`OAUTH_URL:${redirectUrl}\n`)
      })

      server.on('error', (err) => {
        settle(() => reject(new AuthError(`Server error: ${err.message}`, 'INVALID_CODE')))
      })
    })
  }

  async loginWithAccessCode(email: string, code: string): Promise<AuthToken> {
    const adapter = new AccessCodeAuthAdapter(this.client)
    const token = await adapter.exchangeCode(email, code)
    this.token = token
    return token
  }
}
