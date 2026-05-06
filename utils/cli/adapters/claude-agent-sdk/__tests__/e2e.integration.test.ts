/**
 * E2E integration test for the claude-agent-sdk adapter.
 *
 * Proves the full dispatch path works via a tmux subprocess:
 *   config.yaml -> loadConfig -> getCLITarget -> run -> SDK query
 *
 * Gated on ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN being set.
 * The tmux subprocess runs in a separate process tree from the test runner.
 */

import { execSync, execFileSync } from 'child_process'
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs'
import { join, dirname, resolve } from 'path'
import { randomUUID } from 'crypto'
import { fileURLToPath } from 'url'

// Resolve repo root dynamically so this test works in any checkout or CI environment.
// File is at utils/cli/adapters/claude-agent-sdk/__tests__/e2e.integration.test.ts — 5 dirs up.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..')
const TIMESTAMP = Date.now()
const WORKTREE_DIR = `/tmp/sdk-e2e-${TIMESTAMP}`
const SESSION_NAME = `sdk-e2e-${TIMESTAMP}`
const POLL_INTERVAL_MS = 5_000
const MAX_WAIT_MS = 5 * 60 * 1000 // 5 minutes

const hasCredentials = !!process.env.ANTHROPIC_API_KEY || !!process.env.CLAUDE_CODE_OAUTH_TOKEN
// This test launches a full loop epoch inside a tmux subprocess and requires a
// provisioned environment (tmux, pnpm, working loop setup). Gate behind an explicit
// opt-in so it only runs when the environment is known-good, not in PR review workflows.
const canRun = hasCredentials && process.env.CLAUDE_AGENT_SDK_E2E === '1'

function tmuxSessionExists(name: string): boolean {
  try {
    execSync(`tmux has-session -t ${name}`, { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

function killTmuxSession(name: string): void {
  try {
    execSync(`tmux kill-session -t ${name}`, { stdio: 'pipe' })
  } catch {
    // already gone
  }
}

function cleanupWorktree(dir: string): void {
  try {
    execSync(`git -C ${REPO_ROOT} worktree remove --force ${dir}`, { stdio: 'pipe' })
  } catch {
    try {
      execSync(`git -C ${REPO_ROOT} worktree prune`, { stdio: 'pipe' })
    } catch {
      // best effort
    }
  }
  rmSync(dir, { recursive: true, force: true })
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Build a tmux launch script that mirrors launch.ts but clears nesting guards.
 *
 * When tests run inside a Claude Code session, CLAUDECODE is set which prevents
 * the SDK from spawning a child Claude Code process. Since the tmux session is
 * a separate process tree, clearing this variable is the correct behavior --
 * in production launch() is never called from inside Claude Code.
 */
function buildTmuxScript(worktreePath: string, campaignId: string): string {
  const bootMjsPath = worktreePath + '/services/credential-proxy/interceptor-boot.mjs'
  return [
    `cd '${worktreePath}'`,
    // Clear nesting guards -- the tmux session is a separate process tree
    'unset CLAUDECODE',
    'unset CLAUDE_CODE_ENTRYPOINT',
    `export PATH='${worktreePath}'/node_modules/.bin:$PATH`,
    `export EVAL_PROCESS_ID='${campaignId}'`,
    `export NODE_OPTIONS="--import ${bootMjsPath}"`,
    `export WORKTREE_PATH='${worktreePath}'`,
    '',
    'set -o pipefail',
    `npx tsx utils/loop/index.ts --goal-file workspace/goal.md --max-epochs 1 \\`,
    '  2>&1 | tee run-loop.log',
    '',
  ].join('\n')
}

describe('claude-agent-sdk E2E via tmux', () => {
  afterAll(() => {
    // Capture the log before cleanup for debugging failed runs
    const logPath = join(WORKTREE_DIR, 'run-loop.log')
    if (existsSync(logPath)) {
      const log = readFileSync(logPath, 'utf-8')
      if (log.length > 0) {
        const tail = log.split('\n').slice(-30).join('\n')
        console.log(`[e2e] run-loop.log tail:\n${tail}`)
      }
    }
    killTmuxSession(SESSION_NAME)
    cleanupWorktree(WORKTREE_DIR)
  })

  it.runIf(canRun)(
    'full dispatch path produces expected output file',
    async () => {
      // 1. Create a detached worktree
      execFileSync('git', [
        '-C', REPO_ROOT,
        'worktree', 'add', '--detach', WORKTREE_DIR,
      ], { stdio: 'pipe' })

      // 2. Write config.yaml
      writeFileSync(
        join(WORKTREE_DIR, 'config.yaml'),
        [
          'campaign:',
          '  name: sdk-e2e-test',
          'database:',
          '  adapter: none',
          'cli:',
          '  adapter: claude-agent-sdk',
          '  workingDir: .',
          '',
        ].join('\n'),
      )

      // 3. Create workspace/ and goal.md
      mkdirSync(join(WORKTREE_DIR, 'workspace'), { recursive: true })
      writeFileSync(
        join(WORKTREE_DIR, 'workspace', 'goal.md'),
        "Write the string 'sdk-sandbox-verified' to workspace/sdk-cwd-check.txt and nothing else.",
      )

      // 4. Ensure interceptor-boot.mjs exists (launch.ts references it via NODE_OPTIONS)
      const bootPath = join(WORKTREE_DIR, 'services', 'credential-proxy', 'interceptor-boot.mjs')
      if (!existsSync(bootPath)) {
        mkdirSync(join(WORKTREE_DIR, 'services', 'credential-proxy'), { recursive: true })
        writeFileSync(bootPath, '// no-op boot\n')
      }

      // 5. Install deps in the worktree
      execSync('pnpm install --frozen-lockfile', {
        cwd: WORKTREE_DIR,
        stdio: 'pipe',
        timeout: 120_000,
      })

      // 6. Launch the loop in a tmux session
      const campaignId = randomUUID()
      const script = buildTmuxScript(WORKTREE_DIR, campaignId)
      execFileSync('tmux', [
        'new-session', '-d', '-s', SESSION_NAME,
        'bash', '-c', script,
      ], { stdio: 'pipe' })

      // 7. Poll for output file or session exit
      const targetFile = join(WORKTREE_DIR, 'workspace', 'sdk-cwd-check.txt')
      const startTime = Date.now()

      while (Date.now() - startTime < MAX_WAIT_MS) {
        if (existsSync(targetFile)) break
        if (!tmuxSessionExists(SESSION_NAME)) break
        await sleep(POLL_INTERVAL_MS)
      }

      // Grace period if session just exited -- file may be mid-write
      if (!existsSync(targetFile) && !tmuxSessionExists(SESSION_NAME)) {
        await sleep(2_000)
      }

      // Dump log on failure for diagnostics
      const logPath = join(WORKTREE_DIR, 'run-loop.log')
      if (!existsSync(targetFile) && existsSync(logPath)) {
        const log = readFileSync(logPath, 'utf-8')
        const tail = log.split('\n').slice(-40).join('\n')
        console.error(`[e2e] Target file not found. run-loop.log tail:\n${tail}`)
      }

      // 8. Assertions
      expect(existsSync(targetFile)).toBe(true)

      const contents = readFileSync(targetFile, 'utf-8').trim()
      expect(contents).toBe('sdk-sandbox-verified')

      // Wait for tmux session to exit cleanly
      const sessionEnd = Date.now()
      while (tmuxSessionExists(SESSION_NAME) && Date.now() - sessionEnd < 30_000) {
        await sleep(2_000)
      }
    },
    // 6 minute timeout
    360_000,
  )
})
