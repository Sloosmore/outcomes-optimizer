import { getDb, closeDb } from '../src/drizzle-client.js'
import { sql } from 'drizzle-orm'

async function testConnection() {
  try {
    const db = getDb()
    const result = await db.execute(sql`SELECT NOW() as current_time`)
    console.log('Database connected successfully!')
    console.log('Connection test result:', result)
    await closeDb()
    process.exit(0)
  } catch (error) {
    console.error('Database connection failed:', error)
    await closeDb()
    process.exit(1)
  }
}

testConnection()
