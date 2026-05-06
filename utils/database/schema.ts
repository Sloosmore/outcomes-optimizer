// Re-export schema from packages/database/src/schema.ts — single source of truth
// drizzle.config.ts points to this file, so it must contain the full schema.
// The actual definitions live in packages/database/src/schema.ts.
export * from '../../packages/database/src/schema.js'
