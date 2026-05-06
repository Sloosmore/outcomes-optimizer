import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import postgres from 'postgres'
import { ResourcesService } from '../resources.js'
import { ProjectScopeService } from '../project-scope.js'

const RUN_INTEGRATION = !!process.env['RUN_INTEGRATION']

describe.skipIf(!RUN_INTEGRATION)('ProjectScopeService + resolveUserProjects — integration', () => {
  let sql: ReturnType<typeof postgres>
  let resources: ResourcesService
  let scopeService: ProjectScopeService

  // auth.users IDs (used as externalId for resolveUserProjects)
  let authUserAId: string
  let authUserBId: string

  // resource IDs auto-provisioned by trigger
  let userAId: string
  let userBId: string
  let projAId: string
  let projBId: string

  // child resource IDs created manually
  let r1Id: string
  let r2Id: string

  const suffix = `scoping_integ_${Date.now()}`

  beforeAll(async () => {
    const DB_URL = process.env['SKILL_NETWORKS_DATABASE_URL']
    if (!DB_URL) throw new Error('SKILL_NETWORKS_DATABASE_URL not set')
    sql = postgres(DB_URL, { ssl: 'require', max: 3 })
    resources = new ResourcesService(sql as any)
    scopeService = new ProjectScopeService(sql as any)

    // Insert auth.users rows — the handle_new_auth_user trigger automatically
    // calls provision_user() which creates user + project resources + member_of link
    const [authA] = await sql`
      INSERT INTO auth.users (id, email)
      VALUES (gen_random_uuid(), ${`test-a-${suffix}@scoping-integ.test`})
      RETURNING id
    `
    authUserAId = authA.id as string

    const [authB] = await sql`
      INSERT INTO auth.users (id, email)
      VALUES (gen_random_uuid(), ${`test-b-${suffix}@scoping-integ.test`})
      RETURNING id
    `
    authUserBId = authB.id as string

    // Look up the auto-provisioned resource IDs
    const [resA] = await sql`
      SELECT id FROM resources WHERE auth_user_id = ${authUserAId}::uuid AND type = 'user'
    `
    userAId = resA.id as string

    const [resB] = await sql`
      SELECT id FROM resources WHERE auth_user_id = ${authUserBId}::uuid AND type = 'user'
    `
    userBId = resB.id as string

    const [pA] = await sql`
      SELECT id FROM resources WHERE name = ${'project:' + authUserAId} AND type = 'project'
    `
    projAId = pA.id as string

    const [pB] = await sql`
      SELECT id FROM resources WHERE name = ${'project:' + authUserBId} AND type = 'project'
    `
    projBId = pB.id as string

    // Create child data resources R1 (under projA) and R2 (under projB)
    const [r1] = await sql`
      INSERT INTO resources (name, type, status)
      VALUES (${`r1-${suffix}`}, 'data', 'active')
      RETURNING id
    `
    r1Id = r1.id as string

    const [r2] = await sql`
      INSERT INTO resources (name, type, status)
      VALUES (${`r2-${suffix}`}, 'data', 'active')
      RETURNING id
    `
    r2Id = r2.id as string

    // parent links: projA → R1, projB → R2
    await sql`INSERT INTO resource_links (from_id, to_id, link_type) VALUES (${projAId}, ${r1Id}, 'parent') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO resource_links (from_id, to_id, link_type) VALUES (${projBId}, ${r2Id}, 'parent') ON CONFLICT DO NOTHING`
  })

  afterAll(async () => {
    try {
      // 1. Delete links for child resources (parent links to R1/R2)
      if (r1Id) await sql`DELETE FROM resource_links WHERE from_id = ${r1Id} OR to_id = ${r1Id}`
      if (r2Id) await sql`DELETE FROM resource_links WHERE from_id = ${r2Id} OR to_id = ${r2Id}`
      if (projAId) await sql`DELETE FROM resource_links WHERE from_id = ${projAId} OR to_id = ${projAId}`
      if (projBId) await sql`DELETE FROM resource_links WHERE from_id = ${projBId} OR to_id = ${projBId}`
      if (userAId) await sql`DELETE FROM resource_links WHERE from_id = ${userAId} OR to_id = ${userAId}`
      if (userBId) await sql`DELETE FROM resource_links WHERE from_id = ${userBId} OR to_id = ${userBId}`

      // 2. Delete child resources
      if (r1Id) await sql`DELETE FROM resources WHERE id = ${r1Id}`
      if (r2Id) await sql`DELETE FROM resources WHERE id = ${r2Id}`

      // 3. Delete provisioned resources (user + project — no FK pointing at them after step 1)
      if (userAId) await sql`DELETE FROM resources WHERE id = ${userAId}`
      if (userBId) await sql`DELETE FROM resources WHERE id = ${userBId}`
      if (projAId) await sql`DELETE FROM resources WHERE id = ${projAId}`
      if (projBId) await sql`DELETE FROM resources WHERE id = ${projBId}`

      // 4. Delete auth.users rows (resources FK cleared above)
      if (authUserAId) await sql`DELETE FROM auth.users WHERE id = ${authUserAId}::uuid`
      if (authUserBId) await sql`DELETE FROM auth.users WHERE id = ${authUserBId}::uuid`
    } finally {
      await sql.end()
    }
  })

  it("resolveUserProjects(A) returns only A's project", async () => {
    const projects = await resources.resolveUserProjects(authUserAId)
    expect(projects.has(projAId)).toBe(true)
    expect(projects.has(projBId)).toBe(false)
    expect(projects.size).toBe(1)
  })

  it("resolveUserProjects(B) returns only B's project", async () => {
    const projects = await resources.resolveUserProjects(authUserBId)
    expect(projects.has(projBId)).toBe(true)
    expect(projects.has(projAId)).toBe(false)
    expect(projects.size).toBe(1)
  })

  it('resolveUserProjects for unknown user returns empty set', async () => {
    // Must use a valid UUID format since auth_user_id is a UUID column
    const projects = await resources.resolveUserProjects('00000000-0000-0000-0000-000000000000')
    expect(projects.size).toBe(0)
  })

  it("scope.filterResources returns only A's resources (projA + R1)", async () => {
    const authorized = await resources.resolveUserProjects(authUserAId)
    const scope = await scopeService.resolve({ roots: [...authorized] })

    const allResources = [
      { id: projAId },
      { id: projBId },
      { id: r1Id },
      { id: r2Id },
      { id: userAId },
      { id: userBId },
    ]

    const filtered = scope.filterResources(allResources)
    expect(filtered.map((r) => r.id)).toContain(projAId)
    expect(filtered.map((r) => r.id)).toContain(r1Id)
    expect(filtered.map((r) => r.id)).not.toContain(projBId)
    expect(filtered.map((r) => r.id)).not.toContain(r2Id)
  })

  it("after adding member_of A to B's project, A's scope includes B's resources", async () => {
    // Add cross-project membership: user A is now also member of projB
    await sql`INSERT INTO resource_links (from_id, to_id, link_type) VALUES (${userAId}, ${projBId}, 'member_of') ON CONFLICT DO NOTHING`

    try {
      const authorized = await resources.resolveUserProjects(authUserAId)
      expect(authorized.has(projAId)).toBe(true)
      expect(authorized.has(projBId)).toBe(true)

      const scope = await scopeService.resolve({ roots: [...authorized] })

      const allResources = [
        { id: projAId },
        { id: projBId },
        { id: r1Id },
        { id: r2Id },
      ]
      const filtered = scope.filterResources(allResources)
      expect(filtered.map((r) => r.id)).toContain(projAId)
      expect(filtered.map((r) => r.id)).toContain(projBId)
      expect(filtered.map((r) => r.id)).toContain(r1Id)
      expect(filtered.map((r) => r.id)).toContain(r2Id)
    } finally {
      // Remove the cross-membership added in this test
      await sql`DELETE FROM resource_links WHERE from_id = ${userAId} AND to_id = ${projBId} AND link_type = 'member_of'`
    }
  })
})
