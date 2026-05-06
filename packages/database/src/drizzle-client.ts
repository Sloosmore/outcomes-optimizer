import { drizzle, PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type { Sql } from 'postgres'
import * as schema from './schema.js'
import { loadConfig } from '../../../utils/config/index.js'
import { getSqlClient } from './client.js'

type Db = PostgresJsDatabase<typeof schema>

let _db: Db | undefined
let _queryClient: Sql | undefined
let _configChecked = false
let _isEnabled = false

export function isDatabaseEnabled(): boolean {
  if (!_configChecked) {
    const config = loadConfig()
    _isEnabled = config.database.adapter !== 'none'
    _configChecked = true
  }
  return _isEnabled
}

export function getDb(): Db {
  if (_db) return _db

  if (!isDatabaseEnabled()) {
    throw new Error(
      'Database disabled (adapter: none in config.yaml). Enable it or skip DB operations.'
    )
  }

  _queryClient = getSqlClient()
  _db = drizzle(_queryClient, { schema })
  return _db
}

export async function closeDb(): Promise<void> {
  if (_queryClient) {
    await _queryClient.end()
    _queryClient = undefined
    _db = undefined
  }
}

// For testing
export async function _resetForTesting(): Promise<void> {
  await closeDb()
  _configChecked = false
  _isEnabled = false
}
