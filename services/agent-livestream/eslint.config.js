import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores([
    'dist',
    // Generated contract build output — not authored here, linted in the contracts package
    'contracts/dist',
    // Vendored shadcn registry components — not authored by us, linted upstream
    'src/components/agents-ui',
    'src/components/ai-elements',
    'src/hooks/agents-ui',
    // Server test files use 'any' extensively for mocking — excluded from frontend lint
    'server/__tests__',
    'server/tests',
  ]),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    rules: {
      // Allow _-prefixed variables in destructuring and function parameters — standard TypeScript convention
      // for intentionally unused interface implementation parameters and omit-via-destructuring patterns.
      '@typescript-eslint/no-unused-vars': ['error', {
        vars: 'all',
        args: 'all',
        argsIgnorePattern: '^_',
        destructuredArrayIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
        ignoreRestSiblings: true,
      }],
    },
  },
])
