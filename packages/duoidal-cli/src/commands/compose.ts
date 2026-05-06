import { Command } from 'commander'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { spawnSync } from 'node:child_process'

function getProjectName(): { worktreePath: string; projectName: string } {
  const worktreePath = process.env['WORKTREE_PATH']
  if (!worktreePath) {
    console.error('[compose] WORKTREE_PATH environment variable not set')
    process.exit(1)
  }
  const projectFile = path.join(worktreePath, '.duoidal', 'compose-project')
  if (!fs.existsSync(projectFile)) {
    console.error(`[compose] .duoidal/compose-project not found at ${projectFile}`)
    console.error('[compose] Has this worktree been provisioned with --provision compose?')
    process.exit(1)
  }
  const projectName = fs.readFileSync(projectFile, 'utf8').trim()
  const SAFE_PROJECT_NAME = /^[a-z0-9][a-z0-9_-]*$/
  if (!SAFE_PROJECT_NAME.test(projectName) || projectName.length > 128) {
    console.error(`[compose] Invalid project name in .duoidal/compose-project: ${JSON.stringify(projectName)}`)
    process.exit(1)
  }
  return { worktreePath, projectName }
}

export function composeCommand(): Command {
  const cmd = new Command('compose')
  cmd.description('Manage compose services for this worktree')

  cmd
    .command('up')
    .description('Start compose services for this worktree')
    .action(() => {
      const { worktreePath, projectName } = getProjectName()

      // Find compose.yml
      const candidates = [
        path.join(worktreePath, 'compose.yml'),
        path.join(worktreePath, '.duoidal', 'compose.yml'),
      ]
      const composePath = candidates.find(c => fs.existsSync(c))
      if (!composePath) {
        console.error('[compose] No compose.yml found in worktree')
        process.exit(1)
      }

      // Load profiles from .duoidal/compose-config.json
      const profiles: string[] = []
      const configPath = path.join(worktreePath, '.duoidal', 'compose-config.json')
      if (fs.existsSync(configPath)) {
        try {
          const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
          if (Array.isArray(config.profiles)) {
            const SAFE_PROFILE = /^[a-zA-Z0-9_-]+$/
            profiles.push(...(config.profiles as string[]).filter((p: unknown) => typeof p === 'string' && SAFE_PROFILE.test(p as string)))
          }
        } catch (e) {
          console.warn(`[compose] Failed to parse .duoidal/compose-config.json: ${e instanceof Error ? e.message : String(e)}`)
        }
      }

      const args = [
        'compose', '-f', composePath,
        ...profiles.flatMap(p => ['--profile', p]),
        'up', '-d', '--wait', '--wait-timeout', '120',
      ]
      const result = spawnSync('docker', args, {
        env: { ...process.env, COMPOSE_PROJECT_NAME: projectName, WORKTREE_PATH: worktreePath },
        stdio: 'inherit',
        timeout: 150_000,
      })
      process.exit(result.status ?? 1)
    })

  cmd
    .command('down')
    .description('Stop compose services for this worktree')
    .action(() => {
      const { projectName } = getProjectName()
      const result = spawnSync('docker', ['compose', '-p', projectName, 'down', '-v'], {
        stdio: 'inherit',
        timeout: 60_000,
      })
      process.exit(result.status ?? 1)
    })

  cmd
    .command('status')
    .description('Show running containers for this worktree')
    .action(() => {
      const { projectName } = getProjectName()
      const result = spawnSync('docker', ['compose', '-p', projectName, 'ps'], {
        stdio: 'inherit',
        timeout: 15_000,
      })
      process.exit(result.status ?? 1)
    })

  return cmd
}
