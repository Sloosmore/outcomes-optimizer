/**
 * interceptor-boot.mjs — Auto-installs the credential-proxy fetch interceptor.
 *
 * Usage:
 *   NODE_OPTIONS="--import /path/to/interceptor-boot.mjs" node your-script.js
 *
 * Loads the TypeScript interceptor source via tsx (no pre-built dist/ needed)
 * and installs the global fetch patch. When CREDENTIAL_PROXY_URL is unset,
 * the interceptor is a no-op (connection-refused falls through to native fetch).
 */

try {
  // Use tsx's ESM API to load the TypeScript interceptor source.
  //
  // Why not the CJS require path (tsx/cjs hook loading the .ts file via
  // a synchronous require)? The CJS hook routes subsequent bare-specifier
  // imports (e.g. `@skill-networks/logger`) through CJS resolution. When
  // the target package only declares an `import` condition in its `exports`
  // map — as ESM-only packages do — Node's resolver fails with
  // "No 'exports' main defined", because CJS has no matching condition.
  //
  // Why `tsImport` rather than a direct dynamic `import()`?
  // Plain `import()` would use Node's default resolver, which cannot handle
  // `.ts` extensions or the `.js -> .ts` specifier remapping that tsx
  // performs. When interceptor-boot runs via `NODE_OPTIONS=--import`, it
  // executes BEFORE tsx's ESM loader is registered (NODE_OPTIONS preloads
  // run ahead of CLI `--import` flags), so the ambient loader is not yet
  // active. `tsImport` registers a scoped tsx loader on demand and resolves
  // the specifier through it — handling both TypeScript compilation and
  // ESM-only dependency graphs correctly.
  const { tsImport } = await import('tsx/esm/api');
  const { installFetchInterceptor } = await tsImport(
    './src/interceptor.ts',
    import.meta.url,
  );
  installFetchInterceptor();
} catch (err) {
  // Allow the process to continue without the interceptor rather than crashing it.
  process.stderr.write(`[interceptor-boot] Failed to install fetch interceptor: ${err?.message ?? err}\n`);
}
