import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

export default defineConfig({
  resolve: {
    alias: {
      '@skill-networks/logger': resolve(__dirname, 'packages/logger/src/index.ts'),
      '@skill-networks/agent-events': resolve(__dirname, 'packages/agent-events/src/index.ts'),
      // Database subpath aliases (order matters: longer prefixes first).
      // DO NOT add an alias for '@skill-networks/database' root — vite's alias
      // matching is prefix-based, so a root alias redirects ALL subpaths
      // (e.g. '@skill-networks/database/actions' becomes
      // 'packages/database/src/index.ts/actions') which breaks resolution.
      '@skill-networks/database/constants': resolve(__dirname, 'packages/database/src/constants.ts'),
      '@skill-networks/database/client': resolve(__dirname, 'packages/database/src/client.ts'),
      '@skill-networks/database/services': resolve(__dirname, 'packages/database/src/services/index.ts'),
      '@skill-networks/database/actions': resolve(__dirname, 'packages/database/src/actions/index.ts'),
      '@contracts': resolve(__dirname, 'services/agent-livestream/contracts'),
      // agent-livestream `@/...` path alias (matches services/agent-livestream/vitest.config.ts).
      // Without this, tests under services/agent-livestream/src that import `@/foo` fail
      // with ERR_MODULE_NOT_FOUND when run from the root vitest config.
      '@': resolve(__dirname, 'services/agent-livestream/src'),
      // @duoidal/config publishes dist/ which is gitignored; resolve to source so vitest can mock it
      '@duoidal/config': resolve(__dirname, 'packages/duoidal-config/src/index.ts'),
    },
  },
  test: {
    globals: true,
    testTimeout: 30000,
    passWithNoTests: true,
    include: [
      'utils/**/*.test.ts',
      'packages/**/*.test.ts',
      'services/agent-livestream/**/*.test.ts',
    ],
    exclude: [
      '**/node_modules/**',
      // Mirror agent-livestream local vitest.config.ts exclusions
      'services/agent-livestream/tests/**',
      'services/agent-livestream/server/adapters/**/*.test.ts',
      'services/agent-livestream/server/tests/integration/**/*.test.ts',
      // Integration tests require external credentials (INTEGRATION_SKILL_RESOURCE_ID,
      // SUPABASE_URL, SUPABASE_SERVICE_KEY). Run via: doppler run -- bash -c 'RUN_INTEGRATION=true npx vitest run ...'
      'packages/agent-core/src/__tests__/*.e2e.test.ts',
      'packages/agent-core/src/__tests__/goal-link.test.ts',
      'packages/agent-core/src/__tests__/goal-upload.test.ts',
      'packages/agent-core/src/__tests__/metrics-db-smoke.test.ts',
      'packages/database/src/services/__tests__/scoping.integration.test.ts',
      // rpc-matrix tests require RUN_INTEGRATION=true and a real DB.
      // They run via the dedicated "RPC Matrix Integration Tests" workflow,
      // not from `pnpm test` which is the unit-test job.
      'packages/duoidal-cli/src/__tests__/rpc-matrix/**',
    ],
  },
})
