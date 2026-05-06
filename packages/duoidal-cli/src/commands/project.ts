import { Command } from 'commander'
import { getAdapter } from '@duoidal/agent-core'
import { requireAuth } from '../lib/require-auth.js'
import { readProject, writeProject } from '../lib/config.js'

// UUID regex
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function projectCommand(): Command {
  const project = new Command('project')
  project.description('Manage the active duoidal project')

  // LIST subcommand
  project.command('list')
    .description('List projects you are a member of')
    .action(async () => {
      const { sub } = await requireAuth()
      const projects = await getAdapter().listProjectsForUser(sub)
      if (projects.length === 0) {
        console.log('No projects found.')
        return
      }
      const current = readProject()
      for (const p of projects) {
        const marker = current && current.id === p.id ? ' (current)' : ''
        console.log(`${p.name}  ${p.id}${marker}`)
      }
    })

  // SET subcommand
  project.command('set <name-or-uuid>')
    .description('Set the active project by name or UUID')
    .action(async (nameOrId: string) => {
      const { sub } = await requireAuth()
      let found: { id: string; name: string } | null = null
      if (UUID_RE.test(nameOrId)) {
        const r = await getAdapter().getResourceById(nameOrId)
        if (r && r.type === 'project') found = { id: r.id, name: r.name }
      } else {
        const r = await getAdapter().getResource(nameOrId)
        if (r && r.type === 'project') found = { id: r.id, name: r.name }
      }
      if (!found) {
        console.error(`Project not found: ${nameOrId}`)
        process.exit(1)
      }
      const userProjects = await getAdapter().listProjectsForUser(sub)
      if (!userProjects.some(p => p.id === found!.id)) {
        console.error(`You are not a member of project: ${found.name}`)
        process.exit(1)
      }
      writeProject(found)
      console.log(`Active project set to ${found.name} (${found.id})`)
    })

  // CURRENT subcommand
  project.command('current')
    .description('Show the current active project')
    .option('--json', 'Output as JSON')
    .action(async (opts: { json?: boolean }) => {
      // Try local file first
      let p = readProject()
      if (!p) {
        // DB fallback: first project by created_at ASC is the default
        try {
          const { sub } = await requireAuth()
          const projects = await getAdapter().listProjectsForUser(sub)
          if (projects.length > 0) {
            const result = { id: projects[0].id, name: projects[0].name }
            writeProject(result)
            p = result
          }
        } catch {
          // no auth or DB unavailable — fall through
        }
      }
      if (!p) {
        console.error('No active project. Run: duoidal project set <name-or-uuid>')
        process.exit(1)
      }
      if (opts.json) {
        console.log(JSON.stringify(p, null, 2))
      } else {
        console.log(`${p.name}  ${p.id}`)
      }
    })

  return project
}
