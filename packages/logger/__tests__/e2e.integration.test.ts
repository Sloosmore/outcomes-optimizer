import { randomUUID } from 'node:crypto'
import {
  log,
  setMinLevel,
  _resetMinLevel,
  _resetDrains,
  registerDrain,
  DatabaseDrain,
} from '../src/index.js'

const SKIP = !process.env['SUPABASE_PROJECT_ID']

describe.skipIf(SKIP)('E2E: logger level filtering through DatabaseDrain', () => {
  const tag = `e2e-test-${randomUUID()}`

  // Lazily initialized — only when suite actually runs
  let sql: ReturnType<typeof import('postgres').default>
  let db: ReturnType<typeof import('drizzle-orm/postgres-js').drizzle>
  let logs: typeof import('@skill-networks/database/schema').logs

  beforeAll(async () => {
    const postgres = (await import('postgres')).default
    const { drizzle } = await import('drizzle-orm/postgres-js')
    const schema = await import('@skill-networks/database/schema')
    logs = schema.logs

    sql = postgres(process.env['DATABASE_URL']!)
    db = drizzle(sql)

    // Verify connectivity
    await sql`SELECT 1`

    // Clear existing drains, then register DatabaseDrain with manual deps
    _resetDrains()
    const deps = {
      getDb: () => db as any,
      isDatabaseEnabled: () => true,
      logsTable: logs,
    }
    registerDrain(new DatabaseDrain(deps))
  })

  it('Test A: minLevel=info filters out debug', async () => {
    setMinLevel('info')

    log('debug', tag, 'debug message')
    log('info', tag, 'info message')
    log('warn', tag, 'warn message')
    log('error', tag, 'error message')
    log('fatal', tag, 'fatal message')

    // Wait for fire-and-forget drain writes
    await new Promise(r => setTimeout(r, 2000))

    const rows = await sql`SELECT * FROM logs WHERE service = ${tag}`

    expect(rows).toHaveLength(4)
    expect(rows.every((r: any) => r.level !== 'debug')).toBe(true)
    for (const row of rows) {
      expect((row as any).service).toBeTruthy()
      expect((row as any).level).toBeTruthy()
      expect((row as any).message).toBeTruthy()
      expect((row as any).timestamp).toBeTruthy()
    }
  })

  it('Test B: minLevel=debug passes all levels through', async () => {
    setMinLevel('debug')

    log('debug', tag, 'debug message now allowed')

    await new Promise(r => setTimeout(r, 2000))

    const rows = await sql`SELECT * FROM logs WHERE service = ${tag}`

    expect(rows).toHaveLength(5)
    expect(rows.filter((r: any) => r.level === 'debug')).toHaveLength(1)
  })

  afterAll(async () => {
    if (sql) {
      await sql`DELETE FROM logs WHERE service = ${tag}`
      await sql.end()
    }
    _resetDrains()
    _resetMinLevel()
  })
})
