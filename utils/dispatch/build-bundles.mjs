#!/usr/bin/env node
/**
 * Build pre-compiled bundles for the dispatch hot path.
 *
 * Eliminates tsx cold-start overhead by pre-compiling:
 *   provision.ts   → provision.prebuilt.mjs  (~1.1mb, self-contained)
 *   steps/launch.ts → steps/launch.prebuilt.mjs (~10kb, self-contained)
 *   dispatch.ts    → dispatch.prebuilt.mjs   (~630kb, self-contained)
 *
 * Bundles are fully self-contained (all workspace deps inlined) because
 * the node_modules symlinks in the source repo get rewritten by the worktree
 * provisioner on each dispatch run, making external deps unreliable.
 *
 * A CommonJS require() polyfill banner is injected so CJS packages
 * (e.g. commander) work correctly in the ESM bundle context.
 *
 * The dispatch bundle post-processes away launch.ts's main() guard
 * (launch.ts is bundled as a library; its guard would fire incorrectly
 * since import.meta.url is shared across the whole bundle).
 *
 * Usage: node utils/dispatch/build-bundles.mjs
 */

import { execFileSync } from 'child_process'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { resolve, dirname } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Locate esbuild binary: prefer the standard .bin symlink (npm/yarn/pnpm all create it),
// fall back to scanning the pnpm store for any installed esbuild version (present when
// .bin symlink was not created due to blocked install scripts). Dynamic scan avoids
// hardcoding a version string that breaks silently on `pnpm update esbuild`.
function findEsbuild() {
  const dotBin = resolve(__dirname, '../../node_modules/.bin/esbuild')
  if (existsSync(dotBin)) return dotBin
  const pnpmStoreDir = resolve(__dirname, '../../node_modules/.pnpm')
  if (existsSync(pnpmStoreDir)) {
    try {
      const entries = readdirSync(pnpmStoreDir)
      const esbuildBin = entries
        .filter(e => /^esbuild@/.test(e))
        .map(e => resolve(pnpmStoreDir, e, 'node_modules/esbuild/bin/esbuild'))
        .find(p => existsSync(p))
      if (esbuildBin) return esbuildBin
    } catch {
      // pnpm store unreadable — fall through to error
    }
  }
  console.error('ERROR: esbuild binary not found at node_modules/.bin/esbuild or the pnpm store.')
  console.error('Run `pnpm install` first.')
  process.exit(1)
}
const esbuildBin = findEsbuild()

// Banner injects a require() polyfill so CJS packages work in the ESM bundle
const REQUIRE_POLYFILL_BANNER = `import { createRequire } from 'module'; const require = createRequire(import.meta.url);`

function build(entryRel, outRel, extraFlags = []) {
  const entry = resolve(__dirname, entryRel)
  const out = resolve(__dirname, outRel)
  console.log(`Building ${outRel}...`)
  execFileSync(esbuildBin, [
    entry,
    '--bundle',
    '--format=esm',
    '--platform=node',
    `--outfile=${out}`,
    `--banner:js=${REQUIRE_POLYFILL_BANNER}`,
    ...extraFlags,
  ], { stdio: 'inherit' })
}

// 1. Build provision bundle (fully self-contained, entry-point guard correct)
build('provision.ts', 'provision.prebuilt.mjs')

// 2. Build launch bundle (standalone entry point — main guard works correctly here)
build('steps/launch.ts', 'steps/launch.prebuilt.mjs')

// 3. Build dispatch bundle (includes launch.ts code — main guard must be stripped)
build('dispatch.ts', 'dispatch.prebuilt.mjs')

// 4. Post-process: strip launch.ts's main() guard from the dispatch bundle.
//    When multiple files are co-bundled, all share one import.meta.url (the bundle
//    file's URL). The launch.ts guard fires first and exits before dispatch.ts's
//    own main() can run. We remove it since launch.ts is a library in this context.
//
//    The guard is the FIRST occurrence of:
//      if (fileURLToPath(import.meta.url) === process.argv[1]) {
//        main().catch(...)
//      }
//    in the bundle, right before the dispatch.ts section.
const bundlePath = resolve(__dirname, 'dispatch.prebuilt.mjs')
let bundle = readFileSync(bundlePath, 'utf8')

// Match the launch.ts main guard block — it appears before `// utils/dispatch/dispatch.ts`
// Pattern: `if (fileURLToPath... === process.argv[1]) { main().catch(...) }\n`
const launchGuardRe = /^if \(fileURLToPath\(import\.meta\.url\) === process\.argv\[1\]\) \{\n  main\(\)\.catch\(\(e\) => \{\n    console\.error\(e\);\n    process\.exit\(1\);\n  \}\);\n\}\n/m

if (!launchGuardRe.test(bundle)) {
  console.error('ERROR: Could not find launch.ts main guard in dispatch bundle — pattern mismatch.')
  console.error('Inspect the bundle: grep -n "import.meta.url.*process.argv" dispatch.prebuilt.mjs')
  process.exit(1)
}

bundle = bundle.replace(launchGuardRe, '// launch main guard omitted (bundled as library, not entry point)\n')
writeFileSync(bundlePath, bundle, 'utf8')
console.log('Post-processed dispatch.prebuilt.mjs: stripped launch.ts main guard')

// 5. Verify: the dispatch bundle should now have exactly ONE main guard
const guards = [...bundle.matchAll(/if \(fileURLToPath/g)]
if (guards.length !== 1) {
  console.error(`ERROR: Expected 1 main guard in dispatch bundle after post-processing, found ${guards.length}`)
  process.exit(1)
}
console.log('Verification: 1 main guard in dispatch bundle ✓')
console.log('All bundles built successfully.')
