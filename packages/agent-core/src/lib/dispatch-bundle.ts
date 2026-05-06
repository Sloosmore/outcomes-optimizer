/**
 * Resolves the absolute path to `dispatch.prebuilt.mjs` — the pre-compiled
 * bundle that the local-tmux dispatch path executes via `node <bundle>`.
 *
 * The bundle ships WITH the CLI; it has nothing to do with the target repo
 * the operator's cwd is sitting in. Previously the path was computed as
 * `<WORKTREE_REPO>/utils/dispatch/dispatch.prebuilt.mjs`, which silently
 * resolves to a non-existent path whenever `duoidal execute` runs from any
 * cwd that is not the outcomes-optimizer checkout (e.g. a target test repo).
 * Node then ENOENTs at import, the tmux session dies, and the operator
 * sees only the generic "exited immediately" message.
 *
 * Resolution order:
 *   1. `DISPATCH_BUNDLE` env var override — always wins (escape hatch for
 *      bespoke installs and for tests that want to point at a fake bundle).
 *   2. Sibling `dispatch.prebuilt.mjs` next to the running file. This is
 *      the published-CLI case: `tsup` bundles `@duoidal/cli` into a single
 *      `dist/index.js`, and our postbuild step copies the dispatch bundle
 *      next to it as `dist/dispatch.prebuilt.mjs`.
 *   3. Walk upward from the running file looking for
 *      `utils/dispatch/dispatch.prebuilt.mjs`. This is the developer-mode
 *      case: running `pnpm exec duoidal` (or `tsx` against agent-core
 *      sources) inside the outcomes-optimizer worktree, where the bundle lives
 *      at `<repo-root>/utils/dispatch/dispatch.prebuilt.mjs`.
 *
 * Why not anchor on `WORKTREE_REPO` / `process.cwd()`? Because the BUNDLE
 * is part of the CLI, not the workspace. Conflating the two breaks any
 * cross-repo invocation. Anchor on `import.meta.url` — that points at the
 * file doing the resolution, regardless of cwd.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const BUNDLE_NAME = 'dispatch.prebuilt.mjs'
const REPO_RELATIVE = path.join('utils', 'dispatch', BUNDLE_NAME)

export interface ResolveOptions {
  /** Absolute path of the file doing the resolution. Defaults to this module's path. */
  fromFile?: string
  /** Number of parent directories to scan when walking upward. */
  maxAscent?: number
}

/**
 * Resolves the dispatch bundle path. Throws a descriptive error if the
 * bundle cannot be located — the operator gets a clear diagnostic instead
 * of an opaque ENOENT inside tmux.
 */
export function resolveDispatchBundle(opts: ResolveOptions = {}): string {
  // 1. Explicit env override
  const explicit = process.env['DISPATCH_BUNDLE']
  if (explicit) {
    if (!fs.existsSync(explicit)) {
      throw new Error(
        `DISPATCH_BUNDLE=${explicit} does not exist. Either unset it (to use the auto-resolved bundle) or point it at a valid dispatch.prebuilt.mjs.`
      )
    }
    return explicit
  }

  const fromFile = opts.fromFile ?? fileURLToPath(import.meta.url)
  const startDir = path.dirname(fromFile)

  // 2. Sibling bundle — published CLI case (`dist/dispatch.prebuilt.mjs`
  //    next to `dist/index.js`).
  const sibling = path.join(startDir, BUNDLE_NAME)
  if (fs.existsSync(sibling)) return sibling

  // 3. Walk upward looking for `utils/dispatch/dispatch.prebuilt.mjs` —
  //    developer-mode case (running from a outcomes-optimizer checkout).
  const maxAscent = opts.maxAscent ?? 12
  let dir = startDir
  for (let i = 0; i < maxAscent; i++) {
    const candidate = path.join(dir, REPO_RELATIVE)
    if (fs.existsSync(candidate)) return candidate
    const parent = path.dirname(dir)
    if (parent === dir) break // hit filesystem root
    dir = parent
  }

  throw new Error(
    `Could not locate dispatch.prebuilt.mjs.\n` +
    `Searched:\n` +
    `  - $DISPATCH_BUNDLE (unset)\n` +
    `  - ${sibling} (sibling of ${fromFile})\n` +
    `  - ${REPO_RELATIVE} walked up from ${startDir}\n` +
    `\n` +
    `If you are running from source, build the bundle: ` +
    `\`node utils/dispatch/build-bundles.mjs\` from the outcomes-optimizer repo root.\n` +
    `If you are running from a published @duoidal/cli, this is a packaging bug — ` +
    `the dispatch bundle should be shipped next to dist/index.js.`
  )
}
