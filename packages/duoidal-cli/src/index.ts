#!/usr/bin/env node
import diagnostics_channel from 'node:diagnostics_channel'
import { Command } from 'commander'
import { withAdaptiveAliases } from 'cli-adaptive'
import { closeSqlClient } from '@skill-networks/database/client'
import { registerCommands, initAdapter, outputError, classifyExitCode } from '@duoidal/agent-core'
import { registerNullCollector, registerTraceFileCollector, registerStderrCollector } from './lib/collectors.js'
// tsup/esbuild inlines this JSON at build time; no runtime fs.readFileSync
import pkg from '../package.json' with { type: 'json' }
import { authCommand } from './commands/auth.js'
import { sandboxCommand } from './commands/sandbox.js'
import { processCommand } from './commands/process.js'
import { githubCommand } from './commands/github.js'
import { repoCommand } from './commands/repo.js'
import { projectCommand } from './commands/project.js'
import { skillsCommand } from './commands/skills.js'
import { initCommand } from './commands/init.js'
import { healthCommand } from './commands/health.js'
import { diagnoseCommand } from './commands/diagnose.js'
import { composeCommand } from './commands/compose.js'
import { adminCommand } from './commands/admin.js'
import { configCommand } from './commands/config.js'

let _adapterReady = false
async function ensureAdapter(): Promise<void> {
  if (_adapterReady) return
  await initAdapter()
  _adapterReady = true
}

async function main() {
  await import('dotenv/config')

  const commandSlug = process.argv.slice(2).filter(a => !a.startsWith('-')).join('-').replace(/[^a-z0-9-]/gi, '_').slice(0, 40) || 'unknown'

  if (process.env.DUOIDAL_DEBUG) {
    registerStderrCollector()
  } else if (process.env.DUOIDAL_TRACE) {
    registerTraceFileCollector(commandSlug)
  } else {
    registerNullCollector()
  }

  const program = new Command()
  program
    .name('duoidal')
    .description('@duoidal CLI — provision and manage cloud sandboxes')
    .version(pkg.version)

  // Commands that use the Supabase HTTP client directly and do not need the adapter
  const COMMANDS_WITHOUT_ADAPTER = new Set(['auth', 'health', 'diagnose', 'compose', 'github', 'repo', 'sandbox', 'admin', 'init', 'skills', 'config'])

  program.hook('preAction', async (_thisCommand, actionCommand) => {
    // Walk up to find root subcommand name
    let cmd: import('commander').Command = actionCommand
    while (cmd.parent && cmd.parent !== program) {
      cmd = cmd.parent
    }
    if (COMMANDS_WITHOUT_ADAPTER.has(cmd.name())) return
    await ensureAdapter()
  })

  // Register duoidal's own commands
  program.addCommand(authCommand())
  program.addCommand(sandboxCommand())
  const duoidalProcess = processCommand()
  program.addCommand(duoidalProcess)
  program.addCommand(githubCommand())
  program.addCommand(repoCommand())
  program.addCommand(projectCommand())
  program.addCommand(skillsCommand())
  program.addCommand(initCommand())
  program.addCommand(healthCommand())
  program.addCommand(diagnoseCommand())
  program.addCommand(composeCommand())
  program.addCommand(adminCommand())
  program.addCommand(configCommand())

  // Try eager adapter init for dynamic command registration.
  // Non-fatal — preAction hook handles init for commands that need it.
  // Skip when --help/-h or --version/-V is requested: these are inert Commander built-ins
  // that print info and exit 0 regardless of auth state, so they must never trigger auth
  // checks. Also skip for commands that manage their own initialization (auth, health,
  // diagnose) — initAdapter() calls process.exit(1) on auth failure before the promise
  // rejects, so .catch() cannot intercept it. Running eager init for these commands would
  // make `duoidal auth login` unreachable for unauthenticated users.
  const isInfoRequest =
    process.argv.includes('--help') ||
    process.argv.includes('-h') ||
    process.argv.includes('--version') ||
    process.argv.includes('-V')
  const skipEagerInit = COMMANDS_WITHOUT_ADAPTER
  const firstCommand = process.argv.slice(2).find(a => !a.startsWith('-'))
  // Skip eager init when the first token is not in the local (duoidal-specific) command set.
  // Unknown commands will be handled by withAdaptiveAliases instead; agent-core commands use
  // the preAction hook for just-in-time auth, so skipping eager init here is safe.
  const localCommandNames = new Set(program.commands.map(c => c.name()))
  const firstCommandIsLocallyKnown = !firstCommand || (localCommandNames.has(firstCommand) && !skipEagerInit.has(firstCommand))
  if (!_adapterReady && !isInfoRequest && firstCommandIsLocallyKnown) {
    await initAdapter()
      .then(() => { _adapterReady = true })
      .catch(() => { /* silent — adapter not needed for all commands */ })
  }

  // Mount agent-core commands, merging the 'process' command specially
  const tempProgram = new Command()
  await registerCommands(tempProgram)

  // Commands excluded from top-level mounting:
  // - 'link'/'unlink': agent-core's resource-linking commands conflict with the
  //   removed credential-linking commands (which moved to 'sandbox link'/'sandbox unlink').
  //   The goal requires `duoidal link` to return "unknown command". Access via agent-core binary.
  const excludeTopLevel = new Set(['link', 'unlink'])

  const existingTopLevel = new Set(program.commands.map(c => c.name()))
  for (const cmd of tempProgram.commands) {
    if (cmd.name() === 'process') {
      // Merge agent-core's process subcommands into duoidal's process command
      const existingProcessSubs = new Set(duoidalProcess.commands.map(c => c.name()))
      for (const sub of cmd.commands) {
        if (existingProcessSubs.has(sub.name())) {
          throw new Error(`Process subcommand collision: '${sub.name()}' defined in both duoidal and agent-core`)
        }
        duoidalProcess.addCommand(sub)
      }
    } else if (!excludeTopLevel.has(cmd.name())) {
      if (existingTopLevel.has(cmd.name())) {
        // Dynamic type-group command shadowed by a dedicated duoidal command — skip.
        // e.g. 'project' type-group yields to duoidal's projectCommand()
        continue
      }
      program.addCommand(cmd)
    }
  }

  // Non-fatal: alias support unavailable in restricted envs (e.g. read-only homedir)
  try { withAdaptiveAliases(program) } catch { /* alias feature gracefully disabled */ }

  const cmdStart = Date.now()
  let cmdExitCode = 0
  const cmdChannel = diagnostics_channel.channel('skill-networks:command')
  if (cmdChannel.hasSubscribers) {
    // Redact values following sensitive flags (e.g. --token <jwt>) to avoid writing
    // credentials to trace files. Pattern: if a value looks like a JWT or follows a
    // known credential flag, replace with '[REDACTED]'.
    const CREDENTIAL_FLAGS = new Set(['--token', '--password', '--secret', '--api-key', '--access-token'])
    const sanitizedArgs = process.argv.slice(2).map((arg, i, arr) => {
      if (i > 0 && CREDENTIAL_FLAGS.has(arr[i - 1])) return '[REDACTED]'
      if (/^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/.test(arg)) return '[REDACTED]'
      return arg
    })
    try { cmdChannel.publish({ span: 'command', phase: 'entry', duration_ms: 0, status: 'ok', output: { name: commandSlug, args: sanitizedArgs } }) } catch {}
  }
  try {
    await program.parseAsync(process.argv)
    // Capture exitCode set by the adaptive wrapper (e.g. unknown-command path sets it to 1
    // without throwing, which would leave the telemetry reporting status 'ok' incorrectly).
    const exitSignal = process.exitCode
    if (exitSignal != null && exitSignal !== 0 && cmdExitCode === 0) {
      cmdExitCode = typeof exitSignal === 'number' ? exitSignal : 1
    }
  } catch (err) {
    cmdExitCode = 1
    throw err
  } finally {
    if (cmdChannel.hasSubscribers) {
      try { cmdChannel.publish({ span: 'command', phase: 'exit', duration_ms: Date.now() - cmdStart, status: cmdExitCode === 0 ? 'ok' : 'error' }) } catch {}
    }
    await closeSqlClient()
  }
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err)
  const code = msg.includes('TIMEOUT') ? 'TIMEOUT' : 'RUNTIME_ERROR'
  const exitCode = msg.includes('TIMEOUT') ? 2 : classifyExitCode(err)
  outputError({ code, message: msg, retry: false, exitCode })
})
