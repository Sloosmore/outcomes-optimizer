/**
 * Authentication utilities for media adapters
 */

/**
 * Detect whether the credential-proxy interceptor is active.
 * The interceptor patches globalThis.fetch and stores the original
 * as globalThis.__nativeFetch. When active, adapters delegate auth
 * to the proxy via X-Resource headers instead of reading env vars.
 */
export function isInterceptorActive(): boolean {
  return !!(globalThis as unknown as { __nativeFetch?: typeof fetch }).__nativeFetch;
}

/**
 * Get Google API key from environment
 * Supports both GOOGLE_API_KEY and GEMINI_API_KEY
 */
export function getGoogleApiKey(): string {
  const key = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;
  if (!key) {
    throw new Error(
      "GOOGLE_API_KEY or GEMINI_API_KEY environment variable not set"
    );
  }
  return key;
}

/**
 * Get OpenAI API key from environment
 */
export function getOpenAIApiKey(): string {
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    throw new Error("OPENAI_API_KEY environment variable not set");
  }
  return key;
}
