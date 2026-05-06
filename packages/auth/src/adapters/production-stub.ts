import type { AuthAdapter, AuthToken } from './types.js'

/**
 * ProductionAuthStub — placeholder adapter for the production browser-redirect flow.
 * Throws on any method that would require a real Supabase session.
 * Useful as a type-safe stand-in during development when the full OAuth stack
 * is not available. For token-based dev access use DevTokenAdapter instead.
 */
export class ProductionAuthStub implements AuthAdapter {
  readonly type = 'production-stub' as const

  private static readonly ERR =
    'ProductionAuthStub: browser redirect not implemented. Use --token for dev.'

  authenticate(_token: string): Promise<void> {
    throw new Error(ProductionAuthStub.ERR)
  }

  getToken(): Promise<AuthToken> {
    throw new Error(ProductionAuthStub.ERR)
  }

  async isAuthenticated(): Promise<boolean> {
    return false
  }

  async logout(): Promise<void> {
    // no-op
  }
}
