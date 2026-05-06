import { randomUUID } from 'node:crypto'
import postgres from 'postgres'

const DATABASE_URL = process.env['DATABASE_URL']
if (!DATABASE_URL) {
  process.stderr.write('FAIL: DATABASE_URL is required\n')
  process.exit(1)
}

const tag = randomUUID()
const sql = postgres(DATABASE_URL)

async function main(): Promise<void> {
  try {
    await sql`
      INSERT INTO logs (level, service, message, timestamp)
      VALUES ('info', ${`smoke-test-live-${tag}`}, 'E2E smoke test', NOW())
    `

    const rows = await sql`
      SELECT id FROM logs WHERE service = ${`smoke-test-live-${tag}`} LIMIT 1
    `

    await sql`DELETE FROM logs WHERE service = ${`smoke-test-live-${tag}`}`

    await sql.end()

    if (rows.length === 1) {
      process.stdout.write('PASS\n')
      process.exit(0)
    } else {
      process.stdout.write('FAIL\n')
      process.exit(1)
    }
  } catch (err) {
    await sql.end().catch(() => {})
    process.stderr.write(`FAIL: ${String(err)}\n`)
    process.exit(1)
  }
}

main()
