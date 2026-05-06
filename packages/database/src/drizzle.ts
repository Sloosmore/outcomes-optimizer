/**
 * Drizzle client re-exports for Node.js entrypoints that run under tsx.
 * NOT compiled — requires tsx runtime. Do not import from Vercel serverless functions.
 *
 * Used by: DatabaseDrain in node.ts adapters (agent-livestream, credential-proxy, agent-interceptor).
 */
export { getDb, isDatabaseEnabled, closeDb } from './drizzle-client.js'
