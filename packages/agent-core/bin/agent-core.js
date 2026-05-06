#!/usr/bin/env node
// Bootstrap: re-exec with tsx/esm loader to support TypeScript workspace dependencies.
// The @skill-networks/database package exports .ts source files directly, which Node.js
// cannot load without a TypeScript transformer.
import { spawnSync } from 'child_process'
import { createRequire } from 'module'
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// Find tsx binary relative to this package
const require = createRequire(import.meta.url)
let tsxPath
try {
  tsxPath = require.resolve('tsx/package.json')
  tsxPath = resolve(dirname(tsxPath), 'dist', 'cli.mjs')
} catch {
  tsxPath = 'tsx'
}

const result = spawnSync(
  process.execPath,
  ['--import', 'tsx/esm', resolve(__dirname, '../dist/cli.js'), ...process.argv.slice(2)],
  { stdio: 'inherit', env: process.env }
)
process.exit(result.status ?? 1)
