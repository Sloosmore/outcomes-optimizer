import type postgres from 'postgres'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Sql = ReturnType<typeof postgres> | any

export interface ArtifactTile {
  url: string
}

export interface Chat {
  id: string
  title: string | null
  created_at: string
  /** Stage Manager rail. Index 0 = active. Max 4 entries. */
  artifact_tiles: ArtifactTile[]
  /** When true, render via the multi-iframe Stage Manager. When false, single full-bleed iframe. */
  stage_mode: boolean
}

export interface IChatsService {
  create(title?: string): Promise<Chat>
  findById(id: string): Promise<Chat | null>
  findRecent(limit?: number): Promise<Chat[]>
  /** Replace the entire artifact_tiles jsonb array. Caller is responsible for cap/dedupe. */
  updateArtifactTiles(id: string, tiles: ArtifactTile[]): Promise<Chat>
  /** Flip the renderer toggle for a chat. */
  updateStageMode(id: string, enabled: boolean): Promise<Chat>
  upsertById(id: string, title: string): Promise<void>
}

export class ChatsService implements IChatsService {
  constructor(private sql: Sql) {}

  private serializeChat(row: Record<string, unknown>): Chat {
    return {
      ...row,
      created_at: row['created_at'] instanceof Date
        ? (row['created_at'] as Date).toISOString()
        : (row['created_at'] as string),
      // postgres-js may return jsonb as either a parsed array (default behavior
      // in newer versions) or a string (older versions / certain configs). Handle
      // both. Default to [] for safety on legacy rows or test mocks.
      artifact_tiles: ((): ArtifactTile[] => {
        const raw = row['artifact_tiles']
        if (!raw) return []
        if (typeof raw === 'string') {
          try { return JSON.parse(raw) as ArtifactTile[] } catch { return [] }
        }
        return raw as ArtifactTile[]
      })(),
      stage_mode: (row['stage_mode'] as boolean | undefined) ?? false,
    } as unknown as Chat
  }

  async create(title?: string): Promise<Chat> {
    const rows = await this.sql`
      INSERT INTO chats (title) VALUES (${title ?? null}) RETURNING *
    `
    return this.serializeChat(rows[0] as Record<string, unknown>)
  }

  async findById(id: string): Promise<Chat | null> {
    const rows = await this.sql`SELECT * FROM chats WHERE id = ${id}`
    if (!rows[0]) return null
    return this.serializeChat(rows[0] as Record<string, unknown>)
  }

  async findRecent(limit = 50): Promise<Chat[]> {
    const rows = await this.sql`SELECT * FROM chats ORDER BY created_at DESC LIMIT ${limit}`
    return (rows as Record<string, unknown>[]).map(row => this.serializeChat(row))
  }

  async updateArtifactTiles(id: string, tiles: ArtifactTile[]): Promise<Chat> {
    // sql.json() rather than JSON.stringify(...)::jsonb — the latter is double-
    // encoded under Supavisor transaction mode (prepare:false): postgres-js
    // re-encodes the JS string as JSON before sending, so the column ends up
    // storing a JSON string of the array, not the array. credential-resolver.ts
    // and resources.ts have the same pattern documented.
    const rows = await this.sql`
      UPDATE chats SET artifact_tiles = ${this.sql.json(tiles)}
      WHERE id = ${id} RETURNING *
    `
    if (rows.length === 0) throw new Error(`Chat not found: ${id}`)
    return this.serializeChat(rows[0] as Record<string, unknown>)
  }

  async updateStageMode(id: string, enabled: boolean): Promise<Chat> {
    const rows = await this.sql`
      UPDATE chats SET stage_mode = ${enabled} WHERE id = ${id} RETURNING *
    `
    if (rows.length === 0) throw new Error(`Chat not found: ${id}`)
    return this.serializeChat(rows[0] as Record<string, unknown>)
  }

  async upsertById(id: string, title: string): Promise<void> {
    await this.sql`
      INSERT INTO chats (id, title) VALUES (${id}, ${title})
      ON CONFLICT (id) DO NOTHING
    `
  }
}
