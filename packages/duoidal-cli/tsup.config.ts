import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node22',
  bundle: true,
  splitting: false,
  sourcemap: false,
  minify: true,
  clean: true,
  // Bundle workspace deps — they aren't published to npm
  noExternal: ['@duoidal/config', 'cli-adaptive', '@duoidal/agent-core', '@duoidal/auth', '@duoidal/utils', '@skill-networks/database', '@skill-networks/agent-events', '@skill-networks/logger', '@duoidal/sandbox', 'ajv', 'ajv-formats'],
  // Keep public npm deps as external — they resolve at install time
  external: ['commander', 'open', 'dotenv', 'dotenv/config'],
})
