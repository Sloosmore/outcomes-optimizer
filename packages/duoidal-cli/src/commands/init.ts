import { Command } from 'commander'
import { fetchAndWriteSkills } from '../lib/bundled-skills.js'

export function initCommand(): Command {
  const cmd = new Command('init')
    .description('Initialize duoidal config: fetch skills from BFF and write to ~/.config/duoidal/skills/')
    .action(async () => {
      await fetchAndWriteSkills()
      console.log('duoidal: skills fetched and written to ~/.config/duoidal/skills/')
    })

  return cmd
}
