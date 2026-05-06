import type postgres from 'postgres'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Sql = ReturnType<typeof postgres> | any

export interface AgentEvent {
  id: string
  processId: string
  processName: string
  resourceId: string | null
  source: string
  payload: Record<string, unknown>
  ts: string
}

export type AgentEventSource = 'process_continued' | 'process_born_from' | 'goal_amended' | 'process_blocked'

export interface IEventsService {
  getByProcessIds(processIds: string[], opts?: { before?: string; after?: string; limit?: number }): Promise<AgentEvent[]>
  countByProcessIds(processIds: string[]): Promise<number>
  insertAgentEvent(args: { processId: string; processName: string; resourceId: string | null; source: AgentEventSource; payload: Record<string, unknown> }): Promise<void>
}

export class EventsService implements IEventsService {
  constructor(private sql: Sql) {}

  async getByProcessIds(
    processIds: string[],
    opts?: { before?: string; after?: string; limit?: number },
  ): Promise<AgentEvent[]> {
    if (processIds.length === 0) return []

    const limit = opts?.limit ?? 50
    const before = opts?.before
    const after = opts?.after
    const sql = this.sql

    let rows: Record<string, unknown>[]

    if (after) {
      // Polling for new events: ORDER BY ts ASC
      if (before) {
        rows = await sql`
          SELECT id, process_id, process_name, resource_id, source, payload, ts
          FROM agent_events
          WHERE process_id::text = ANY(${sql.array(processIds)})
            AND ts > ${after}
            AND ts < ${before}
          ORDER BY ts ASC
          LIMIT ${limit}
        `
      } else {
        rows = await sql`
          SELECT id, process_id, process_name, resource_id, source, payload, ts
          FROM agent_events
          WHERE process_id::text = ANY(${sql.array(processIds)})
            AND ts > ${after}
          ORDER BY ts ASC
          LIMIT ${limit}
        `
      }
    } else if (before) {
      // Initial load with before cursor: ORDER BY ts DESC then reverse
      rows = await sql`
        SELECT id, process_id, process_name, resource_id, source, payload, ts
        FROM agent_events
        WHERE process_id::text = ANY(${sql.array(processIds)})
          AND ts < ${before}
        ORDER BY ts DESC
        LIMIT ${limit}
      `
      rows = [...rows].reverse()
    } else {
      // No cursor: most recent N, reversed to ascending order
      rows = await sql`
        SELECT id, process_id, process_name, resource_id, source, payload, ts
        FROM agent_events
        WHERE process_id::text = ANY(${sql.array(processIds)})
        ORDER BY ts DESC
        LIMIT ${limit}
      `
      rows = [...rows].reverse()
    }

    return rows.map(row => ({
      id: row.id as string,
      processId: row.process_id as string,
      processName: row.process_name as string,
      resourceId: (row.resource_id as string | null) ?? null,
      source: row.source as string,
      payload: row.payload as Record<string, unknown>,
      ts: row.ts instanceof Date ? (row.ts as Date).toISOString() : (row.ts as string),
    }))
  }

  async countByProcessIds(processIds: string[]): Promise<number> {
    if (processIds.length === 0) return 0

    const sql = this.sql
    const rows = await sql`
      SELECT COUNT(*) AS count
      FROM agent_events
      WHERE process_id::text = ANY(${sql.array(processIds)})
    `
    return Number((rows[0] as { count: string | number }).count)
  }

  async insertAgentEvent(args: {
    processId: string
    processName: string
    resourceId: string | null
    source: AgentEventSource
    payload: Record<string, unknown>
  }): Promise<void> {
    await this.sql`
      INSERT INTO agent_events (process_id, process_name, resource_id, source, payload)
      VALUES (${args.processId}, ${args.processName}, ${args.resourceId}, ${args.source}, ${this.sql.json(args.payload)})
    `
  }
}
