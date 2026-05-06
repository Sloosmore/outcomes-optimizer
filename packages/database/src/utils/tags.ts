import { eq, and } from 'drizzle-orm'
import { getDb } from '../drizzle-client.js'
import { tags, tagEntities } from '../schema.js'

export type Tag = typeof tags.$inferSelect
export type EntityType = 'resource' | 'training_set' | 'trace'

export async function upsertTag(name: string): Promise<Tag> {
  const db = getDb()
  const [row] = await db
    .insert(tags)
    .values({ name })
    .onConflictDoUpdate({ target: tags.name, set: { name } })
    .returning()
  return row
}

export async function attachTag(entityId: string, entityType: EntityType, tagId: string): Promise<void> {
  const db = getDb()
  await db
    .insert(tagEntities)
    .values({ entityId, entityType, tagId })
    .onConflictDoNothing()
}

export async function getTagsForEntity(entityId: string, entityType: EntityType): Promise<Tag[]> {
  const db = getDb()
  const rows = await db
    .select({ id: tags.id, name: tags.name, createdAt: tags.createdAt })
    .from(tagEntities)
    .innerJoin(tags, eq(tagEntities.tagId, tags.id))
    .where(and(eq(tagEntities.entityId, entityId), eq(tagEntities.entityType, entityType)))
  return rows
}
