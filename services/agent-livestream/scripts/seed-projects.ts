#!/usr/bin/env npx tsx
/**
 * Seed script: Create test projects and skills for cross-project isolation tests.
 * Idempotent — safe to run multiple times.
 * NOT a Supabase migration — test fixtures only.
 *
 * Usage: SKILL_NETWORKS_DATABASE_URL=... npx tsx scripts/seed-projects.ts
 *   OR:  doppler run -- npx tsx scripts/seed-projects.ts
 */
import { getSqlClient } from '@skill-networks/database/client'
import { ResourcesService } from '@skill-networks/database'

const sql = getSqlClient()
const resources = new ResourcesService(sql)

async function seed() {
  console.log('Seeding test projects...')

  // Upsert project resources
  const sandboxProject = await resources.upsertByName({
    name: 'sandbox-testing',
    type: 'project',
    status: 'active',
    config: { initials: 'ST', displayName: 'Sandbox Testing' },
  })
  console.log('sandbox-testing project:', sandboxProject.id)

  const experimentalProject = await resources.upsertByName({
    name: 'experimental',
    type: 'project',
    status: 'active',
    config: { initials: 'EX', displayName: 'Experimental' },
  })
  console.log('experimental project:', experimentalProject.id)

  // Upsert skill resources for sandbox-testing (2 skills)
  const sandboxAlpha = await resources.upsertByName({
    name: 'sandbox-testing/alpha',
    type: 'skill',
    status: 'active',
    config: { displayName: 'Sandbox Alpha', category: 'test' },
  })
  const sandboxBeta = await resources.upsertByName({
    name: 'sandbox-testing/beta',
    type: 'skill',
    status: 'active',
    config: { displayName: 'Sandbox Beta', category: 'test' },
  })
  console.log('sandbox skills:', sandboxAlpha.id, sandboxBeta.id)

  // Upsert skill resource for experimental (1 skill)
  const experimentalGamma = await resources.upsertByName({
    name: 'experimental/gamma',
    type: 'skill',
    status: 'active',
    config: { displayName: 'Experimental Gamma', category: 'test' },
  })
  console.log('experimental skill:', experimentalGamma.id)

  // Create parent links: project -> skills
  // (from_id=project, to_id=skill, link_type='parent' — BFS direction in filterToOkrTree)
  await resources.createLinkById(sandboxProject.id, sandboxAlpha.id, 'parent')
  await resources.createLinkById(sandboxProject.id, sandboxBeta.id, 'parent')
  await resources.createLinkById(experimentalProject.id, experimentalGamma.id, 'parent')
  console.log('Parent links created')

  // Find developer-leverage project (should already exist)
  const devLeverageProject = await resources.findByNameAndType('developer-leverage', 'project')
  if (devLeverageProject) {
    console.log('developer-leverage project found:', devLeverageProject.id)
  } else {
    console.log('developer-leverage project not found — skipping')
  }

  // Find user resources and link to all projects
  // org.ts uses listLinksFromId(userResourceId) → findByTypeAndIds('project', ...)
  // so any link from user → project is picked up by the OrgSwitcher
  const userResources = await resources.list({ type: 'user', status: 'active' })
  console.log(`Found ${userResources.length} user resource(s)`)

  for (const user of userResources) {
    if (devLeverageProject) {
      await resources.createLinkById(user.id, devLeverageProject.id, 'member_of')
    }
    await resources.createLinkById(user.id, sandboxProject.id, 'member_of')
    await resources.createLinkById(user.id, experimentalProject.id, 'member_of')
    console.log(`Linked user '${user.name}' to projects`)
  }

  console.log('Seed complete!')
  await sql.end()
}

seed().catch((err) => {
  console.error('Seed failed:', err)
  process.exit(1)
})
