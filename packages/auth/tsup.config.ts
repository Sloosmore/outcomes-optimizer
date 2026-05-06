import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts', 'src/adapters/index.ts', 'src/token.ts', 'src/services/auth-db.ts'],
  format: ['esm'],
  target: 'node22',
  bundle: true,
  splitting: false,
  sourcemap: false,
  clean: true,
  dts: true,
})
