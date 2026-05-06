import { Command } from 'commander'

export function processCommand(): Command {
  const process_ = new Command('process')
  process_.description('Manage processes')

  return process_
}
