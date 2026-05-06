import { and, eq } from 'drizzle-orm'
import { getDb } from '../drizzle-client.js'
import { processDependencies } from '../schema.js'

/**
 * Record that processId depends on dependencyId (dependency must complete first).
 * The DB trigger rejects inserts that would create a cycle.
 * Idempotent: duplicate inserts are ignored (ON CONFLICT DO NOTHING via PK).
 */
export async function addDependency(processId: string, dependencyId: string): Promise<void> {
  if (processId === dependencyId) {
    throw new Error('A process cannot depend on itself')
  }
  const db = getDb()
  await db
    .insert(processDependencies)
    .values({ processId, dependencyId })
    .onConflictDoNothing()
}

/**
 * Return all dependencies of a given process (campaigns it is waiting on).
 */
export async function getDependencies(processId: string) {
  const db = getDb()
  return db
    .select()
    .from(processDependencies)
    .where(eq(processDependencies.processId, processId))
}

/**
 * Return all processes that depend on a given campaign (its dependents).
 */
export async function getDependents(dependencyId: string) {
  const db = getDb()
  return db
    .select()
    .from(processDependencies)
    .where(eq(processDependencies.dependencyId, dependencyId))
}

/**
 * Remove a specific dependency row. Used when a dependency is no longer needed.
 */
export async function removeDependency(processId: string, dependencyId: string): Promise<void> {
  const db = getDb()
  await db
    .delete(processDependencies)
    .where(and(
      eq(processDependencies.processId, processId),
      eq(processDependencies.dependencyId, dependencyId),
    ))
}
