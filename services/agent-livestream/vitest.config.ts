import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

const isIntegration = process.env['NODE_ENV'] === 'integration'

const sharedAlias = {
  '@contracts': resolve(__dirname, 'contracts'),
  '@': resolve(__dirname, 'src'),
  // @skill-networks/contracts is the npm-published package pointing to the same source.
  // No dist/ folder in this repo — resolve directly to source for test runs.
  '@skill-networks/contracts': resolve(__dirname, 'contracts'),
  '@skill-networks/logger': resolve(__dirname, '../../packages/logger/src/index.ts'),
  '@skill-networks/database/actions': resolve(__dirname, '../../packages/database/src/actions/index.ts'),
  '@skill-networks/database/constants': resolve(__dirname, '../../packages/database/src/constants.ts'),
  '@skill-networks/database/client': resolve(__dirname, '../../packages/database/src/client.ts'),
  '@skill-networks/database/services': resolve(__dirname, '../../packages/database/src/services/index.ts'),
  '@duoidal/sandbox': resolve(__dirname, '../../packages/sandbox/src/index.ts'),
}

export default defineConfig({
  resolve: { alias: sharedAlias },
  test: {
    globals: true,
    // src/ React hook tests require jsdom; server/ tests need Node (jose uses crypto.subtle).
    // Use inline projects to split environments without touching test files.
    projects: [
      {
        extends: true,
        resolve: { alias: sharedAlias },
        test: {
          name: 'src',
          environment: 'jsdom',
          include: ['src/**/__tests__/**/*.test.ts'],
          exclude: ['**/node_modules/**'],
        },
      },
      {
        extends: true,
        resolve: { alias: sharedAlias },
        test: {
          name: 'server',
          environment: 'node',
          include: [
            'server/__tests__/**/*.test.ts',
            'server/*.test.ts',
            'server/routes/*.test.ts',
            'shared/*.test.ts',
            ...(isIntegration ? ['server/tests/integration/**/*.test.ts'] : []),
          ],
          exclude: [
            'tests/**',
            'server/adapters/**/*.test.ts',
            '**/*.integration.test.ts',
            '**/node_modules/**',
          ],
          // Run integration test files sequentially to avoid SSH key conflicts
          ...(isIntegration ? {
            pool: 'forks',
            poolOptions: {
              forks: {
                singleFork: true,
              },
            },
          } : {}),
        },
      },
    ],
  },
})
