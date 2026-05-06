/**
 * Common token response returned by all auth adapters
 */
export interface AuthToken {
  /** JWT access token */
  accessToken: string;
  /** JWT refresh token (if available) */
  refreshToken?: string;
  /** Expiry timestamp in seconds since epoch */
  expiresAt?: number;
}

/**
 * Credentials for restoring a previously authenticated session
 */
export interface AuthCredentials {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  [key: string]: unknown;
}

/**
 * Common interface for all auth adapters.
 * Each adapter represents a different authentication surface
 * (browser session, CLI local server, headless access code).
 */
export interface AuthAdapter {
  /** Get the current access token, refreshing if needed */
  getToken(): Promise<AuthToken>;
  /** Check if the adapter has a valid (non-expired) session */
  isAuthenticated(): Promise<boolean>;
  /** Clear the current session */
  logout(): Promise<void>;
}

/**
 * AccessCodeAuthAdapter — headless adapter that exchanges an email + access
 * code for a Supabase JWT. No browser required.
 * Used for E2E tests and CLI `--access-code` flag.
 */
export interface AccessCodeAuthAdapter extends AuthAdapter {
  readonly type: 'access-code';
  /** Exchange email + access code for a session token */
  exchangeCode(email: string, code: string): Promise<AuthToken>;
}

/**
 * BrowserAuthAdapter — wraps @supabase/supabase-js browser session.
 * Used by the frontend (agent-livestream).
 */
export interface BrowserAuthAdapter extends AuthAdapter {
  readonly type: 'browser';
}

/**
 * CLIAuthAdapter — launches a local HTTP redirect server + opens browser for
 * OAuth flow. Also accepts --access-code path delegating to AccessCodeAuthAdapter.
 */
export interface CLIAuthAdapter extends AuthAdapter {
  readonly type: 'cli';
  /** Start the local OAuth redirect server and open browser */
  startOAuthFlow(): Promise<AuthToken>;
  /** Start the local redirect server pointing to an app's /cli-auth route */
  startAppFlow(appUrl: string): Promise<AuthToken>;
  /** Use headless access code path instead of browser flow */
  loginWithAccessCode(email: string, code: string): Promise<AuthToken>;
}

/**
 * Provider-agnostic auth session. Maps any provider session (Supabase, Firebase, etc.)
 * to a common shape. No provider-specific fields leak into this type.
 */
export interface AuthSession {
  /** JWT access token */
  accessToken: string
  /** Authenticated user details */
  user: {
    id: string
    email: string
    metadata: Record<string, unknown>
  }
  /** Expiry timestamp in seconds since epoch (optional) */
  expiresAt?: number
}

/**
 * SessionAdapter — session lifecycle for browser consumers.
 * Separate from AuthAdapter (token lifecycle for CLI/server/agents).
 *
 * Implementations accept SupabaseClient (or other provider client) via
 * constructor injection — they do NOT create their own client.
 */
export interface SessionAdapter {
  /** Sign in using adapter-specific strategy */
  signIn(email?: string, code?: string, options?: { returnTo?: string }): Promise<{ error: Error | null }>
  /** Get current session mapped to provider-agnostic AuthSession */
  getSession(): Promise<AuthSession | null>
  /** Subscribe to auth state changes */
  onAuthStateChange(cb: (session: AuthSession | null) => void): { unsubscribe: () => void }
  /** Sign out and clear session */
  signOut(): Promise<void>
}
