import { Command } from 'commander'
import fs from 'node:fs'
import { writeToken, readToken, TOKEN_PATH } from '../lib/config.js'
import { getSupabaseAnonKey, getSupabaseUrl } from '../lib/helpers.js'
import { decodeJwt, getSubClaim, NonUuidSubError } from '@duoidal/auth'

// AuthToken shape from @duoidal/auth (defined locally to avoid rootDir violations)
interface AuthToken {
  accessToken: string
  refreshToken?: string
  expiresAt?: number
}


// Adapter interfaces (defined locally for DI and testing)
export interface IAccessCodeAdapter {
  exchangeCode(email: string, code: string): Promise<AuthToken>
}

export interface ICLIAdapter {
  startOAuthFlow(): Promise<AuthToken>
  startAppFlow(appUrl: string): Promise<AuthToken>
  loginWithAccessCode(email: string, code: string): Promise<AuthToken>
}

// Factory types for dependency injection
export type AccessCodeAdapterFactory = (supabaseUrl: string, supabaseAnonKey: string) => IAccessCodeAdapter
export type CLIAdapterFactory = (supabaseUrl: string, supabaseAnonKey: string) => ICLIAdapter

// Default factory implementations using @duoidal/auth
async function loadAuthAdapters(): Promise<{
  CLIAuthAdapter: new (client: unknown) => ICLIAdapter
  AccessCodeAuthAdapter: new (client: unknown) => IAccessCodeAdapter
  createSupabaseClient: (url: string, key: string) => unknown
}> {
  // @ts-ignore — tsup bundles @duoidal/auth via noExternal; TS rootDir prevents static resolution
  return import('@duoidal/auth/adapters') as Promise<{
    CLIAuthAdapter: new (client: unknown) => ICLIAdapter
    AccessCodeAuthAdapter: new (client: unknown) => IAccessCodeAdapter
    createSupabaseClient: (url: string, key: string) => unknown
  }>
}

function mapAuthToken(token: AuthToken) {
  return {
    access_token: token.accessToken,
    refresh_token: token.refreshToken ?? '',
    expires_at: token.expiresAt,
  }
}

export function authCommand(
  cliAdapterFactory?: CLIAdapterFactory,
  accessCodeAdapterFactory?: AccessCodeAdapterFactory
): Command {
  const auth = new Command('auth')
  auth.description('Authenticate with @duoidal')

  auth.command('login')
    .description('Log in via browser OAuth or access code')
    .option('--token <jwt>', 'Directly set a JWT token (for testing/scripting)')
    .option('--access-code <code>', 'Log in with an email access code (OTP)')
    .option('--email <email>', 'Email address (required with --access-code)')
    .option('--with-token', 'Read JWT token from stdin (for piped use: duoidal auth token | ssh root@<ip> "duoidal auth login --with-token")')
    .option('--app-url <url>', 'App URL for browser auth (defaults to https://example.com)')
    .action(async (opts: { token?: string; accessCode?: string; email?: string; withToken?: boolean; appUrl?: string }) => {
      // Direct token injection (for testing/E2E) — keep exact behavior for backward compat
      if (opts.token) {
        writeToken({ access_token: opts.token, refresh_token: '' })
        console.log('Token stored at ~/.config/duoidal/token.json')
        return
      }

      // --with-token: read JWT from stdin
      if (opts.withToken) {
        if (process.stdin.isTTY) {
          process.stderr.write('Error: --with-token reads from stdin (pipe). Example:\n  duoidal auth token | ssh root@<ip> "duoidal auth login --with-token"\n')
          process.exit(1)
        }

        // Read stdin with a size limit (JWTs are never multi-KB)
        const MAX_JWT_SIZE = 16384
        const chunks: Buffer[] = []
        let totalSize = 0
        for await (const chunk of process.stdin) {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
          totalSize += buf.length
          if (totalSize > MAX_JWT_SIZE) {
            process.stderr.write('Error: input exceeds maximum JWT size\n')
            process.exit(1)
          }
          chunks.push(buf)
        }
        const jwtToken = Buffer.concat(chunks).toString('utf-8').trim()

        // Validate JWT structure (must have exactly 3 parts separated by '.')
        if (jwtToken.split('.').length !== 3) {
          process.stderr.write('Error: invalid JWT structure (expected 3 parts separated by .)\n')
          process.exit(1)
        }

        writeToken({ access_token: jwtToken, refresh_token: '' })
        console.log('Token stored at ~/.config/duoidal/token.json')
        return
      }

      // Access code flow
      if (opts.accessCode) {
        if (!opts.email) {
          console.error('Error: --email is required when using --access-code')
          process.exit(1)
        }

        const supabaseUrl = getSupabaseUrl()
        const supabaseAnonKey = getSupabaseAnonKey()

        let adapter: IAccessCodeAdapter
        if (accessCodeAdapterFactory) {
          adapter = accessCodeAdapterFactory(supabaseUrl, supabaseAnonKey)
        } else {
          const { AccessCodeAuthAdapter, createSupabaseClient } = await loadAuthAdapters()
          adapter = new AccessCodeAuthAdapter(createSupabaseClient(supabaseUrl, supabaseAnonKey))
        }

        const token = await adapter.exchangeCode(opts.email, opts.accessCode)
        writeToken(mapAuthToken(token))
        console.log('Token stored at ~/.config/duoidal/token.json')
        return
      }

      // Browser OAuth flow via CLIAuthAdapter
      const supabaseUrl = getSupabaseUrl()
      const supabaseAnonKey = getSupabaseAnonKey()

      let cliAdapter: ICLIAdapter
      if (cliAdapterFactory) {
        cliAdapter = cliAdapterFactory(supabaseUrl, supabaseAnonKey)
      } else {
        const { CLIAuthAdapter, createSupabaseClient } = await loadAuthAdapters()
        cliAdapter = new CLIAuthAdapter(createSupabaseClient(supabaseUrl, supabaseAnonKey))
      }

      // Intercept the OAUTH_URL emitted by CLIAuthAdapter and open browser
      const origWrite = process.stdout.write.bind(process.stdout)
      let browserOpened = false
      process.stdout.write = ((chunk: unknown, ...args: unknown[]) => {
        const str = typeof chunk === 'string' ? chunk : chunk instanceof Buffer ? chunk.toString() : String(chunk)
        if (!browserOpened && str.startsWith('OAUTH_URL:')) {
          const url = str.slice('OAUTH_URL:'.length).trim()
          browserOpened = true
          console.log('\nOpening browser for authentication...')
          console.log(`If browser does not open automatically, visit:\n  ${url}\n`)
          import('open').then(({ default: open }) => open(url)).catch(() => {})
        }
        return (origWrite as (...a: unknown[]) => boolean)(chunk, ...args)
      }) as typeof process.stdout.write

      const appUrl = (opts.appUrl && opts.appUrl.length > 0)
        ? opts.appUrl
        : (process.env['DUOIDAL_APP_URL'] && process.env['DUOIDAL_APP_URL'].length > 0)
          ? process.env['DUOIDAL_APP_URL']
          : 'https://example.com'

      try {
        const token = await cliAdapter.startAppFlow(appUrl)
        process.stdout.write = origWrite
        writeToken(mapAuthToken(token))
        console.log('Authenticated. Token stored at ~/.config/duoidal/token.json')
      } catch (err) {
        process.stdout.write = origWrite
        console.error('Authentication failed:', err instanceof Error ? err.message : String(err))
        process.exit(1)
      }
    })

  // auth token — print the stored access_token to stdout
  auth.command('token')
    .description('Print the stored access token to stdout')
    .action(() => {
      const stored = readToken()
      if (!stored) {
        console.error('Not logged in. Run: duoidal auth login')
        process.exit(1)
      }
      console.log(stored.access_token)
    })

  // auth logout — remove the stored token
  auth.command('logout')
    .description('Log out and remove stored credentials')
    .action(() => {
      try {
        fs.unlinkSync(TOKEN_PATH)
      } catch (err) {
        // Succeed silently if file doesn't exist
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw err
        }
      }
      console.log('Logged out.')
    })

  // auth whoami — print the email of the currently authenticated user
  auth.command('whoami')
    .description('Print the email of the currently authenticated user')
    .action(() => {
      const stored = readToken()
      if (!stored?.access_token) {
        console.error('Not logged in. Run: duoidal auth login')
        process.exit(1)
      }
      // getSubClaim validates the sub is a UUID and throws NonUuidSubError
      // if it isn't — keeps fixture-style tokens from leaking past whoami.
      // See @duoidal/auth/token.ts for the central rule; whoami just lets
      // the error surface with its own actionable message.
      let sub: string
      try {
        sub = getSubClaim(stored.access_token)
      } catch (err) {
        if (err instanceof NonUuidSubError) {
          console.error(err.message)
        } else {
          console.error('Failed to decode token')
        }
        process.exit(1)
        return
      }
      const email = decodeJwt(stored.access_token).email ?? sub
      console.log(email)
    })

  // auth invalidate — mark the stored token as expired (for testing refresh flows)
  auth.command('invalidate')
    .description('Mark the stored token as expired by writing a past expires_at (preserves tokens, forces refresh on next command)')
    .action(() => {
      const stored = readToken()
      if (!stored) {
        console.error('Not logged in. Run: duoidal auth login')
        process.exit(1)
      }
      writeToken({
        access_token: stored.access_token,
        refresh_token: stored.refresh_token,
        expires_at: 0,
      })
      console.log('Token marked as expired. Next command will attempt to refresh the session.')
    })

  return auth
}
