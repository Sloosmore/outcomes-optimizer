#!/usr/bin/env npx tsx
/**
 * Process Restart Utility
 *
 * Marks an active process as failed, creates a replacement process linked to
 * the same branch/goal, and optionally re-launches the loop on the dispatch host.
 *
 * Usage:
 *   npx tsx scripts/process-restart/index.ts --id <process-id> --reason "why" [--no-relaunch]
 */
import { execFileSync } from 'child_process'

const OPENCLAW_HOST = process.env.OPENCLAW_HOST
const OPENCLAW_SSH_KEY = process.env.OPENCLAW_SSH_KEY
if (!OPENCLAW_HOST) throw new Error('OPENCLAW_HOST must be set')
if (!OPENCLAW_SSH_KEY) throw new Error('OPENCLAW_SSH_KEY must be set')

// Branch names must be safe for interpolation into shell scripts on the remote host.
// Only alphanumeric chars, slashes, hyphens, underscores, and dots are permitted.
const SAFE_BRANCH = /^[a-zA-Z0-9/_.-]+$/

function agentCore(...args: string[]): string {
  const cliParts = (process.env['SKILL_NETWORKS_CLI'] ?? 'pnpm exec duoidal').split(' ')
  return execFileSync(cliParts[0], [...cliParts.slice(1), 'process', ...args], {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim()
}

function parseArgs(argv: string[]): { id: string; reason: string; relaunch: boolean } {
  const args = argv.slice(2)
  let id = ''
  let reason = ''
  let relaunch = true

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--id') {
      id = args[++i]
    } else if (args[i] === '--reason') {
      reason = args[++i]
    } else if (args[i] === '--no-relaunch') {
      relaunch = false
    }
  }

  if (!id) {
    console.error('Error: --id is required')
    console.error('Usage: npx tsx scripts/process-restart/index.ts --id <process-id> --reason "why" [--no-relaunch]')
    process.exit(1)
  }

  if (!reason) {
    console.error('Error: --reason is required')
    console.error('Usage: npx tsx scripts/process-restart/index.ts --id <process-id> --reason "why" [--no-relaunch]')
    process.exit(1)
  }

  return { id, reason, relaunch }
}

async function main() {
  const { id, reason, relaunch } = parseArgs(process.argv)

  // Step 1: Mark the process as failed
  console.log(`Marking process ${id} as failed: "${reason}"`)
  agentCore('fail', '--id', id, '--reason', reason)
  console.log('Marked as failed.')

  // Step 2: Read branch and goal-file from the failed process
  const statusJson = agentCore('status', '--id', id, '--json')
  const status = JSON.parse(statusJson) as { branch?: string; name?: string }
  const branch = status.branch
  if (!branch) {
    console.error(`Error: process ${id} has no branch set — cannot create replacement`)
    process.exit(1)
  }
  if (!SAFE_BRANCH.test(branch)) {
    console.error(`Error: branch name contains unsafe characters: ${JSON.stringify(branch)}`)
    process.exit(1)
  }
  console.log(`Branch: ${branch}`)

  // Step 3: Create a new process for the same branch
  // Derive a unique name: slug + timestamp to avoid unique-name conflicts
  const slug = branch.replace(/\//g, '-')
  const name = `${slug}-${Date.now()}`
  console.log(`Creating new process for branch ${branch} (name: ${name})...`)
  const initOutput = agentCore('init', '--branch', branch, '--name', name)
  // agent-core process init prints the UUID on the last non-empty line
  const newId = initOutput.split('\n').filter(Boolean).pop()!.trim()
  if (!newId.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)) {
    console.error(`Error: unexpected output from process init: ${JSON.stringify(initOutput)}`)
    process.exit(1)
  }

  // Step 4: Print the new process ID
  console.log(`New process ID: ${newId}`)

  // Step 5: SSH into openclaw and restart the loop (unless --no-relaunch)
  if (!relaunch) {
    console.log('Skipping relaunch (--no-relaunch)')
    return
  }

  const sessionSlug = branch.replace(/^[^/]+\//, '') // strip leading "feat/" etc.
  const worktreePath = `/root/dispatch/${sessionSlug}`

  console.log(`Relaunching on openclaw: session=${sessionSlug}, worktree=${worktreePath}`)

  // Update EVAL_PROCESS_ID in the remote .env file then send Ctrl-C + restart
  const remoteScript = `
    set -e
    # Update .env with new process ID
    if [ -f "${worktreePath}/.env" ]; then
      sed -i 's/EVAL_PROCESS_ID=.*/EVAL_PROCESS_ID="${newId}"/' "${worktreePath}/.env"
      echo ".env updated: EVAL_PROCESS_ID=${newId}"
    else
      echo "EVAL_PROCESS_ID=${newId}" >> "${worktreePath}/.env"
      echo ".env created with: EVAL_PROCESS_ID=${newId}"
    fi

    # Kill any running loop in the tmux session and restart
    tmux send-keys -t "${sessionSlug}" C-c "" 2>/dev/null || true
    sleep 2

    # Re-source .env and restart the loop
    tmux send-keys -t "${sessionSlug}" "export EVAL_PROCESS_ID=${newId} && npx tsx utils/loop/index.ts --goal-file workspace/goal.md --max-epochs 10 2>&1 | tee run-loop.log" Enter
    echo "Loop restarted in tmux session: ${sessionSlug}"
  `

  execFileSync('ssh', [
    '-i', OPENCLAW_SSH_KEY,
    '-o', 'StrictHostKeyChecking=accept-new',
    `root@${OPENCLAW_HOST}`,
    remoteScript,
  ], { stdio: 'inherit', encoding: 'utf-8' })

  console.log(`Done. New process ${newId} is running on openclaw.`)
}

main().catch(err => {
  console.error('Error:', err.message)
  process.exit(1)
})
