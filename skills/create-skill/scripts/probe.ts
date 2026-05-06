#!/usr/bin/env npx tsx
/**
 * probe.ts — Selects the next codebase target and generates a probe goal.
 *
 * Usage:
 *   npx tsx skills/create-skill/scripts/probe.ts
 *   npx tsx skills/create-skill/scripts/probe.ts --output /path/to/worktree/workspace/goal.md
 *
 * Selection: staleness-first (never-touched → oldest last_touched), weighted by
 * git churn (CodeScene hotspot formula). Skips targets currently in_progress.
 *
 * Output: a goal.md scoped to the selected target, written to workspace/goal.md
 * (or --output path). State file updated with the selection.
 */

import { execSync } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ProbeConfig {
  scan_roots: string[]
  exclude: string[]
  subdivide_threshold: number
  output: string
}

interface TargetState {
  last_touched: string | null  // ISO timestamp or null (never touched)
  last_branch: string | null
  churn_commits_90d: number | null
  status: 'queued' | 'in_progress' | 'completed' | 'skipped'
}

interface ProbeState {
  schema_version: string
  targets: Record<string, TargetState>
  last_run: string | null
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const REPO_ROOT = execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim()
const SCRIPTS_DIR = path.join(REPO_ROOT, 'skills/create-skill/scripts')
const CONFIG_PATH = path.join(SCRIPTS_DIR, 'probe-config.json')
const STATE_PATH = path.join(SCRIPTS_DIR, 'probe-state.json')
const TEMPLATE_PATH = path.join(SCRIPTS_DIR, 'probe-template.md')

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

function countSourceFiles(dir: string): number {
  try {
    const out = execSync(
      `find "${dir}" \\( -name "*.ts" -o -name "*.tsx" \\) | grep -v node_modules | grep -v /dist/ | wc -l`,
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }
    )
    return parseInt(out.trim(), 10) || 0
  } catch {
    return 0
  }
}

function discoverTargets(config: ProbeConfig): string[] {
  const targets: string[] = []

  for (const root of config.scan_roots) {
    const rootPath = path.join(REPO_ROOT, root)
    if (!fs.existsSync(rootPath)) continue

    for (const entry of fs.readdirSync(rootPath, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue

      const rel = `${root}/${entry.name}`
      if (config.exclude.some(ex => rel === ex || rel.startsWith(`${ex}/`))) continue

      const fullPath = path.join(REPO_ROOT, rel)
      const fileCount = countSourceFiles(fullPath)
      if (fileCount === 0) continue

      if (fileCount > config.subdivide_threshold) {
        // Too large — register top-level src subdirectories instead
        const srcPath = fs.existsSync(path.join(fullPath, 'src'))
          ? path.join(fullPath, 'src')
          : fullPath
        const srcRel = fs.existsSync(path.join(fullPath, 'src'))
          ? `${rel}/src`
          : rel

        const subs = fs.readdirSync(srcPath, { withFileTypes: true })
          .filter(s => s.isDirectory())
          .map(s => ({ name: s.name, count: countSourceFiles(path.join(srcPath, s.name)) }))
          .filter(s => s.count > 0)

        if (subs.length > 0) {
          subs.forEach(s => targets.push(`${srcRel}/${s.name}`))
        } else {
          targets.push(rel) // fallback: use as-is
        }
      } else {
        targets.push(rel)
      }
    }
  }

  return targets
}

// ---------------------------------------------------------------------------
// Scoring (CodeScene hotspot formula)
// ---------------------------------------------------------------------------

function getChurn(targetPath: string): number {
  try {
    const out = execSync(
      `git -C "${REPO_ROOT}" log --oneline --since="90 days ago" -- "${targetPath}" | wc -l`,
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }
    )
    return parseInt(out.trim(), 10) || 0
  } catch {
    return 0
  }
}

function computeScore(state: TargetState, maxChurn: number): number {
  // Never-touched always wins
  if (state.last_touched === null) {
    // Tiebreak never-touched by churn (higher churn = more important to check first)
    // Use 1e12 (not MAX_SAFE_INTEGER) to leave room for churn addition without precision loss
    return 1e12 + (state.churn_commits_90d ?? 0)
  }

  const days = (Date.now() - new Date(state.last_touched).getTime()) / 86_400_000
  const churnNorm = maxChurn > 0 ? (state.churn_commits_90d ?? 0) / maxChurn : 0

  // Hotspot formula: staleness amplified by churn
  return days * (1 + churnNorm)
}

// ---------------------------------------------------------------------------
// Goal template
// ---------------------------------------------------------------------------

function getKeyFiles(targetPath: string): string[] {
  const fullPath = path.join(REPO_ROOT, targetPath)
  return ['index.ts', 'index.tsx', 'src/index.ts', 'CLAUDE.md']
    .map(f => path.join(fullPath, f))
    .filter(f => fs.existsSync(f))
    .map(f => path.relative(REPO_ROOT, f))
    .slice(0, 4)
}

/**
 * Walk up from the target toward the repo root, find the nearest CLAUDE.md,
 * and extract its ## Verification section. Returns null if not found.
 */
function readVerificationCache(targetPath: string): { section: string; source: string } | null {
  const parts = targetPath.split('/')
  for (let i = parts.length; i >= 1; i--) {
    const dir = path.join(REPO_ROOT, parts.slice(0, i).join('/'))
    const claudePath = path.join(dir, 'CLAUDE.md')
    if (!fs.existsSync(claudePath)) continue
    const content = fs.readFileSync(claudePath, 'utf8')
    const match = content.match(/## Verification\n([\s\S]*?)(?=\n## |\n---\s*$|$)/)
    if (match) {
      return {
        section: match[1].trim(),
        source: path.relative(REPO_ROOT, claudePath),
      }
    }
  }
  return null
}

function generateGoal(target: string, _churn: number): string {
  const name = target.split('/').pop()!
  const targetName = name
  const keyFiles = getKeyFiles(target)
  const keyFilesNote = keyFiles.length > 0
    ? `\nKey entry points: ${keyFiles.map(f => `\`${f}\``).join(', ')}\n`
    : ''

  const cache = readVerificationCache(target)
  const verificationBlock = cache
    ? `From \`${cache.source}\`:\n\n${cache.section}`
    : `No verification cache exists yet for this target. Derive the verification method from the tests and code you find. After making your change, document how you verified it by adding or updating \`## Verification\` in the nearest \`CLAUDE.md\` for \`${target}\`.`

  const verificationNote = cache
    ? `If your change reveals a better or more rigorous verification method than what is cached, update \`${cache.source}\` — future agents use this as their baseline.`
    : `Once you derive the verification method, write it to \`${target}/CLAUDE.md\` under \`## Verification\` so future agents can build on it.`

  const template = fs.readFileSync(TEMPLATE_PATH, 'utf8')

  return template
    .replace(/\{\{name\}\}/g, name)
    .replace(/\{\{target\}\}/g, target)
    .replace(/\{\{targetName\}\}/g, targetName)
    .replace(/\{\{keyFilesNote\}\}/g, keyFilesNote)
    .replace(/\{\{verificationBlock\}\}/g, verificationBlock)
    .replace(/\{\{verificationNote\}\}/g, verificationNote)
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

if (!fs.existsSync(CONFIG_PATH)) {
  console.error(`Config not found: ${CONFIG_PATH}`)
  console.error('Create probe-config.json with: scan_roots, exclude, subdivide_threshold, output')
  process.exit(1)
}
const config: ProbeConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))

const state: ProbeState = fs.existsSync(STATE_PATH)
  ? JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'))
  : { schema_version: '1', targets: {}, last_run: null }

// Discover current repo targets
const discovered = discoverTargets(config)

// Merge discovered into state — new targets start as queued/never-touched
for (const t of discovered) {
  if (!state.targets[t]) {
    state.targets[t] = {
      last_touched: null,
      last_branch: null,
      churn_commits_90d: null,
      status: 'queued',
    }
  }
}

// Eligible: must be in current discovered set, not in_progress or skipped
const eligible = Object.entries(state.targets).filter(
  ([key, val]) =>
    discovered.includes(key) &&
    val.status !== 'in_progress' &&
    val.status !== 'skipped'
)

if (eligible.length === 0) {
  console.error('No eligible targets. All are in_progress or skipped.')
  process.exit(1)
}

// Populate churn lazily (cache in state, reuse if already set)
for (const [target, targetState] of eligible) {
  if (targetState.churn_commits_90d === null) {
    process.stderr.write(`  churn: ${target}... `)
    targetState.churn_commits_90d = getChurn(target)
    process.stderr.write(`${targetState.churn_commits_90d} commits\n`)
  }
}

const maxChurn = Math.max(...eligible.map(([, s]) => s.churn_commits_90d ?? 0), 1)

// Sort by score descending, pick the top
const sorted = [...eligible].sort(
  ([, a], [, b]) => computeScore(b, maxChurn) - computeScore(a, maxChurn)
)
const [selectedTarget, selectedState] = sorted[0]

console.log(`\nSelected: ${selectedTarget}`)
console.log(`  last_touched: ${selectedState.last_touched ?? 'never'}`)
console.log(`  churn_90d:    ${selectedState.churn_commits_90d} commits`)

// Claim immediately — minimizes the race window to just JSON serialize + write (~5ms).
// Everything after this point (goal generation, file I/O) is safe to be slow.
state.targets[selectedTarget].status = 'in_progress'
state.last_run = new Date().toISOString()
fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n', 'utf8')

// Generate goal
const goal = generateGoal(selectedTarget, selectedState.churn_commits_90d ?? 0)

// Resolve output path
const outputArgIdx = process.argv.indexOf('--output')
if (outputArgIdx !== -1) {
  const val = process.argv[outputArgIdx + 1]
  if (!val || val.startsWith('-')) {
    console.error('--output requires a path argument')
    process.exit(1)
  }
}
const outputPath = outputArgIdx !== -1
  ? path.resolve(process.argv[outputArgIdx + 1])
  : path.join(REPO_ROOT, config.output ?? 'workspace/goal.md')

fs.mkdirSync(path.dirname(outputPath), { recursive: true })
fs.writeFileSync(outputPath, goal, 'utf8')
console.log(`Goal written to: ${outputPath}`)
