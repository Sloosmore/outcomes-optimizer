// eslint.config.mjs — repo-wide ESLint 9 flat config
// Each package can register per-package rules in its own eslint.rules.js file.
// The root config scans for these files and merges them scoped to that package's path.
//
// eslint.rules.js can export either:
//   - An array of ESLint flat config objects (preferred — allows sub-directory scoping)
//   - A single rules object { rules: { ... } } (scoped to the whole package src/ by root config)
//
// Run from repo root: pnpm lint

import tseslint from 'typescript-eslint';
import { existsSync, readdirSync } from 'fs';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

// Discover all eslint.rules.js files in packages/ and services/
function discoverRuleFiles() {
  const results = [];
  for (const dir of ['packages', 'services']) {
    const fullDir = resolve(__dirname, dir);
    if (!existsSync(fullDir)) continue;
    try {
      for (const pkg of readdirSync(fullDir)) {
        const pkgPath = resolve(fullDir, pkg);
        const rulesFile = resolve(pkgPath, 'eslint.rules.js');
        if (existsSync(rulesFile)) {
          results.push({ pkg, dir, rulesFile, pkgPath });
        }
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(`[eslint.config.mjs] Failed to scan ${fullDir}:`, e instanceof Error ? e.message : String(e));
    }
  }
  return results;
}

// Load per-package rules dynamically.
// If the export is an array, it is merged as-is (package controls scoping via files[]).
// If the export is an object with a `rules` key, it is wrapped with a default files[] pattern
// scoped to that package's src/, server/, and scripts/ directories.
async function loadPackageRules() {
  const configs = [];
  for (const { pkg, dir, rulesFile } of discoverRuleFiles()) {
    try {
      const mod = await import(rulesFile);
      const pkgExport = mod.default ?? mod;
      if (Array.isArray(pkgExport)) {
        // Package controls its own scoping — merge directly
        configs.push(...pkgExport);
      } else if (pkgExport && typeof pkgExport === 'object') {
        // Legacy object export — scope to the whole package src/
        const filePatterns = [
          `${dir}/${pkg}/src/**/*.ts`,
          `${dir}/${pkg}/src/**/*.tsx`,
          `${dir}/${pkg}/server/**/*.ts`,
          `${dir}/${pkg}/scripts/**/*.ts`,
        ];
        configs.push({
          files: filePatterns,
          ...pkgExport,
        });
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(`[eslint.config.mjs] Failed to load rules for ${dir}/${pkg}:`, e.message);
    }
  }
  return configs;
}

const packageConfigs = await loadPackageRules();

export default tseslint.config(
  // Global ignores — never lint build artifacts, configs, or JS output
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/*.js',
      '**/*.mjs',
      '**/*.cjs',
      '**/eslint.rules.js',
      '**/vitest.config.ts',
      '**/tsup.config.ts',
      '**/drizzle/**',
      '**/migrations/**',
      '**/__tests__/**',
      '**/test/**',
      '**/tests/**',
      // Test files scattered in src/ — not production code, excluded from lint gate
      '**/*.test.ts',
      '**/*.test.tsx',
      '**/*.spec.ts',
      '**/*.spec.tsx',
      // agent-livestream src/ has its own ESLint config with react-hooks/react-refresh plugins
      // that are not installed at the repo root. The server/ and scripts/ are covered by
      // the sql-ban rules in services/agent-livestream/eslint.rules.js.
      'services/agent-livestream/src/**',
      // scheduler and runtime are out of scope for this goal — separate consolidation effort
      'packages/scheduler/**',
      'services/runtime/**',
    ],
  },

  // Global TypeScript rules — applied to all packages/services TypeScript source files
  {
    files: [
      'packages/*/src/**/*.ts',
      'packages/*/src/**/*.tsx',
      'services/*/src/**/*.ts',
      'services/*/src/**/*.tsx',
      'services/*/server/**/*.ts',
      'services/*/scripts/**/*.ts',
    ],
    plugins: {
      '@typescript-eslint': tseslint.plugin,
    },
    languageOptions: {
      parser: tseslint.parser,
    },
    rules: {
      // Catch dead code — unused variables indicate incomplete refactors
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],
      // Push toward typed code — explicit any is a type-safety gap
      '@typescript-eslint/no-explicit-any': 'warn',
      // Enforce import type for type-only imports — reduces circular deps and bundle size
      '@typescript-eslint/consistent-type-imports': ['warn', { prefer: 'type-imports' }],
      // Default: warn on console usage — packages override to error where structured logger is required
      'no-console': 'warn',
      // All DB connections must go through getSqlClient() from packages/database.
      // Direct postgres imports bypass the 3-tier fallback (env → alias → Supavisor JWT).
      // Exception: packages/database/src/ is the one place that IS the factory.
      'no-restricted-imports': ['error', {
        paths: [{
          name: 'postgres',
          message: 'Import getSqlClient() from @skill-networks/database/client instead. Direct postgres imports bypass the connection factory.',
        }],
      }],
    },
  },

  // Exception: packages/database/src/ is allowed to import postgres directly
  // (it IS the connection factory).
  {
    files: ['packages/database/src/**/*.ts'],
    rules: {
      'no-restricted-imports': 'off',
    },
  },

  // Per-package rules merged from eslint.rules.js files
  ...packageConfigs,
);
