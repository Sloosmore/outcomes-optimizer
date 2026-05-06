#!/usr/bin/env node
import { Command } from 'commander'
import { closeSqlClient } from '@skill-networks/database/client'
import { registerCommands, initAdapter } from './index.js'

let _adapterReady = false
async function ensureAdapter() {
  if (_adapterReady) return
  await initAdapter()
  _adapterReady = true
}

async function main() {
  await import('dotenv/config')
  const program = new Command()
  program
    .name('agent-core')
    .description('CLI for runtime discovery of all resources and exclusive checkout of finite ones')
    .version('0.1.0')

  await registerCommands(program)

  // Initialize the postgres adapter before any action runs (skip for auth-free commands)
  program.hook('preAction', async (_thisCommand, actionCommand) => {
    let cmd = actionCommand
    while (cmd.parent && cmd.parent !== program) {
      cmd = cmd.parent
    }
    if (cmd.name() === 'types') return
    await ensureAdapter()
  })

  try {
    await program.parseAsync(process.argv)
  } finally {
    await closeSqlClient()
  }
}

main().catch(e => {
  console.error('Error:', e instanceof Error ? e.message : e)
  process.exit(1)
})
