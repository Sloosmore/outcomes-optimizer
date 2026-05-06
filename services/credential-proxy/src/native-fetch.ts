/**
 * Typed accessor for the unpatched fetch stored by the interceptor.
 *
 * Lives inside the service tree so that tsc (rootDir: ./src) can compile
 * it without cross-tree imports.
 */

/**
 * Access the unpatched fetch stored by the credential-proxy interceptor.
 * Falls back to globalThis.fetch when no interceptor is active.
 */
export function getNativeFetch(): typeof fetch {
  return (
    (globalThis as unknown as { __nativeFetch?: typeof fetch }).__nativeFetch ??
    globalThis.fetch
  );
}
