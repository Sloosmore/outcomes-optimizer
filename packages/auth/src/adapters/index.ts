export type {
  AuthAdapter,
  AuthToken,
  AuthCredentials,
  AccessCodeAuthAdapter as IAccessCodeAuthAdapter,
  BrowserAuthAdapter as IBrowserAuthAdapter,
  CLIAuthAdapter as ICLIAuthAdapter,
} from './types.js'
export { AccessCodeAuthAdapter, AuthError } from './access-code.js'
export { BrowserAuthAdapter } from './browser.js'
export { CLIAuthAdapter } from './cli.js'
export { createSupabaseClient, createAuthenticatedSupabaseClient, refreshSession } from './supabase.js'
export { DevTokenAdapter } from './dev-token.js'
export { ProductionAuthStub } from './production-stub.js'

// Session adapters — browser-side auth lifecycle (sign in, get session, subscribe to changes)
export type { SessionAdapter, AuthSession } from './types.js'
export { DebugSessionAdapter } from './debug-session.js'
export { AnonymousSessionAdapter } from './anonymous-session.js'
export { UserSessionAdapter } from './user-session.js'
export { MagicLinkSessionAdapter } from './magic-link-session.js'
