import type postgres from 'postgres'

type Sql = ReturnType<typeof postgres>

type AgentEventSource = 'process_continued' | 'process_born_from' | 'goal_amended'

const INTERVAL_RE = /^\d+\s+(seconds?|minutes?|hours?|days?|weeks?)$/i

export interface ProcessRow {
  id: string
  name: string
  status: string
  current_epoch: number | null
  metrics: Record<string, unknown> | null
  updated_at: Date | null
  created_at: Date | null
  started_at: Date | null
  completed_at: Date | null
  branch: string | null
  training_resource_id: string | null
  resume_at: Date | null
  worktree_path: string | null
  resume_context: string | null
  root_process_id: string | null
  channel_id: string | null
  skill_resource_id: string | null
  progress: number | null
  project_id: string | null
}

export interface EpochResultRow {
  epoch_number: number
  status: string
  completed_at: Date | null
}

export interface WaitingProcessRow {
  id: string
  resume_context: string | null
}

export interface OrphanProcessRow {
  id: string
  name: string
  worktree_path: string | null
}

export interface IProcessesService {
  init(opts: {
    name: string
    branch?: string
    runType?: string
    skillResourceId?: string
    resolvedTrainingResourceId?: string | null
    channelId?: string | null
    status?: string
    prompt?: string
    parentProcessId?: string
    projectId?: string
    worktreePath?: string
  }): Promise<string>

  getById(id: string): Promise<ProcessRow | null>

  getByName(name: string): Promise<ProcessRow[]>

  listLeaves(): Promise<ProcessRow[]>

  query(opts?: { status?: string | string[]; since?: string; projectId?: string }): Promise<ProcessRow[]>

  activate(id: string): Promise<void>

  complete(id: string): Promise<void>

  fail(id: string, reason?: string): Promise<void>

  reset(id: string): Promise<void>

  sleep(
    id: string,
    interval: string,
    resumeContext?: string | null,
  ): Promise<{ resume_at: Date; new_segment_id: string }>

  claim(id: string): Promise<boolean>

  restart(deadId: string): Promise<{ newId: string; originalProcess: ProcessRow }>

  amend(
    id: string,
    appendText: string,
    opts: { skillResourceId: string; worktreePath: string; processName: string; goalContent: string },
  ): Promise<void>

  resolveChain(rootProcessId: string): Promise<ProcessRow[]>

  getEpochs(processId: string, limit?: number): Promise<EpochResultRow[]>

  upsertEpochResult(
    processId: string,
    epochNumber: number,
    data: Record<string, unknown>,
  ): Promise<void>

  updateAggregate(processId: string, touchedEpochs: number[]): Promise<void>

  resolveTrainingSetId(trainingSetId: string): Promise<string>

  block(id: string, reason: string, worktreePath?: string | null): Promise<void>

  findWaitingProcesses(projectId?: string): Promise<WaitingProcessRow[]>

  findOrphanProcesses(cutoff: Date): Promise<OrphanProcessRow[]>
}

export class ProcessesService implements IProcessesService {
  constructor(private sql: Sql) {}

  async init(opts: {
    name: string
    branch?: string
    runType?: string
    skillResourceId?: string
    resolvedTrainingResourceId?: string | null
    channelId?: string | null
    status?: string
    prompt?: string
    parentProcessId?: string
    projectId?: string
    worktreePath?: string
  }): Promise<string> {
    const { name, branch, runType, skillResourceId, resolvedTrainingResourceId, channelId, projectId, worktreePath } = opts
    const effectiveStatus = opts.status ?? 'pending'
    const resumeContext = opts.prompt ? JSON.stringify({ prompt: opts.prompt }) : null
    const sql = this.sql

    const rows: { id: string }[] = await sql`
      INSERT INTO processes (name, branch, status, training_resource_id, skill_resource_id, run_type, channel_id, resume_context, parent_process_id, project_id, worktree_path)
      VALUES (${name}, ${branch ?? null}, ${effectiveStatus}, ${resolvedTrainingResourceId ?? null}, ${skillResourceId ?? null}, ${runType ?? null}, ${channelId ?? null}, ${resumeContext}, ${opts.parentProcessId ?? null}, ${projectId ?? null}, ${worktreePath ?? null})
      RETURNING id
    `
    if (rows.length === 0) throw new Error(`Failed to insert process "${name}": INSERT returned no rows`)
    return rows[0].id
  }

  async getById(id: string): Promise<ProcessRow | null> {
    const rows: ProcessRow[] = await this.sql`
      SELECT id, name, status, current_epoch, metrics, updated_at, started_at, completed_at, branch, training_resource_id, resume_at, worktree_path, resume_context, root_process_id, channel_id, skill_resource_id, project_id
      FROM processes WHERE id = ${id}
    `
    return rows[0] ?? null
  }

  async getByName(name: string): Promise<ProcessRow[]> {
    const rows: ProcessRow[] = await this.sql`
      SELECT id, name, status, current_epoch, metrics, updated_at, started_at, completed_at, branch, training_resource_id, resume_at, worktree_path, resume_context, root_process_id, channel_id, skill_resource_id, project_id
      FROM processes WHERE name = ${name}
      ORDER BY updated_at DESC, id DESC
    `
    return rows
  }

  async listLeaves(): Promise<ProcessRow[]> {
    const rows = await this.sql`
      SELECT * FROM (
        SELECT DISTINCT ON (root_process_id) *
        FROM processes
        ORDER BY root_process_id, created_at DESC
      ) leaf
      ORDER BY updated_at DESC, id DESC
    `
    return rows as unknown as ProcessRow[]
  }

  async query(opts?: { status?: string | string[]; since?: string; projectId?: string }): Promise<ProcessRow[]> {
    const sql = this.sql
    const statuses = opts?.status
      ? (Array.isArray(opts.status) ? opts.status : [opts.status])
      : null
    const projectId = opts?.projectId ?? null
    const rows = await sql`
      SELECT id, name, status, skill_resource_id, current_epoch, created_at, completed_at, updated_at, progress, project_id FROM processes
      WHERE TRUE
      ${statuses ? sql`AND status = ANY(${sql.array(statuses)})` : sql``}
      ${opts?.since ? sql`AND created_at >= ${opts.since}` : sql``}
      ${projectId ? sql`AND project_id = ${projectId}` : sql``}
      ORDER BY created_at DESC LIMIT 200
    `
    return rows as unknown as ProcessRow[]
  }

  async activate(id: string): Promise<void> {
    const sql = this.sql
    const rows: { id: string }[] = await sql`
      UPDATE processes
      SET status = 'active',
          started_at = NOW(),
          updated_at = NOW()
      WHERE id = ${id} AND status IN ('pending', 'waiting')
      RETURNING id
    `
    if (rows.length === 0) {
      const existing: { id: string; status: string }[] = await sql`SELECT id, status FROM processes WHERE id = ${id}`
      if (existing.length === 0) throw new Error(`Process not found: ${id}`)
      const { status } = existing[0]
      if (status === 'active') return // already active — idempotent
      throw new Error(`Cannot activate process ${id}: current status is ${status}`)
    }
  }

  async complete(id: string): Promise<void> {
    const sql = this.sql
    let rows: { id: string }[]
    try {
      rows = await sql`
        UPDATE processes
        SET status = 'completed',
            completed_at = NOW(),
            updated_at = NOW()
        WHERE id = ${id} AND status = 'active'
        RETURNING id
      `
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (!(msg.includes('completed_at') && msg.includes('does not exist'))) throw err
      rows = await sql`
        UPDATE processes
        SET status = 'completed',
            updated_at = NOW()
        WHERE id = ${id} AND status = 'active'
        RETURNING id
      `
    }
    if (rows.length === 0) {
      const existing: { id: string; status: string }[] = await sql`SELECT id, status FROM processes WHERE id = ${id}`
      if (existing.length === 0) throw new Error(`Process not found: ${id}`)
      if (existing[0].status !== 'completed') {
        if (process.env.DUOIDAL_DEBUG) {
          process.stderr.write(JSON.stringify({ level: 'warn', code: 'PROCESS_STATE_MISMATCH', message: `Cannot complete process ${id}: current status is ${existing[0].status}` }) + '\n')
        }
      }
      // Already completed — idempotent
    }
  }

  async fail(id: string, reason?: string): Promise<void> {
    const sql = this.sql
    let rows: { id: string }[]
    if (reason) {
      try {
        rows = await sql`
          UPDATE processes
          SET status = 'failed',
              failure_reason = ${reason},
              updated_at = NOW()
          WHERE id = ${id} AND status IN ('active', 'pending', 'waiting')
          RETURNING id
        `
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (!(msg.includes('failure_reason') && msg.includes('does not exist'))) throw err
        rows = await sql`
          UPDATE processes
          SET status = 'failed',
              updated_at = NOW()
          WHERE id = ${id} AND status IN ('active', 'pending', 'waiting')
          RETURNING id
        `
      }
    } else {
      rows = await sql`
        UPDATE processes
        SET status = 'failed',
            updated_at = NOW()
        WHERE id = ${id} AND status IN ('active', 'pending', 'waiting')
        RETURNING id
      `
    }

    if (rows.length === 0) {
      const existing: { id: string; status: string }[] = await sql`SELECT id, status FROM processes WHERE id = ${id}`
      if (existing.length === 0) throw new Error(`Process not found: ${id}`)
      const status = existing[0].status
      if (status !== 'failed' && status !== 'completed') {
        if (process.env.DUOIDAL_DEBUG) {
          process.stderr.write(JSON.stringify({ level: 'warn', code: 'PROCESS_STATE_MISMATCH', message: `Cannot fail process ${id}: current status is ${status}` }) + '\n')
        }
      }
      // Already failed or completed — no-op
    }
  }

  async reset(id: string): Promise<void> {
    const sql = this.sql
    let rows: { id: string }[]
    try {
      rows = await sql`
        UPDATE processes
        SET status = 'pending',
            failure_reason = NULL,
            started_at = NULL,
            completed_at = NULL,
            updated_at = NOW()
        WHERE id = ${id} AND status = 'failed'
        RETURNING id
      `
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (!(msg.includes('failure_reason') && msg.includes('does not exist'))) throw err
      rows = await sql`
        UPDATE processes
        SET status = 'pending',
            started_at = NULL,
            completed_at = NULL,
            updated_at = NOW()
        WHERE id = ${id} AND status = 'failed'
        RETURNING id
      `
    }
    if (rows.length === 0) {
      const existing: { id: string; status: string }[] = await sql`SELECT id, status FROM processes WHERE id = ${id}`
      if (existing.length === 0) throw new Error(`Process not found: ${id}`)
      throw new Error(`Cannot reset process ${id}: current status is ${existing[0].status} (only failed processes can be reset)`)
    }
  }

  async sleep(
    id: string,
    interval: string,
    resumeContext: string | null = null,
  ): Promise<{ resume_at: Date; new_segment_id: string }> {
    if (!INTERVAL_RE.test(interval)) {
      throw new Error('interval must be a simple duration like "30 minutes" or "1 hour"')
    }
    let parsed: Record<string, unknown> | null = null
    if (resumeContext) {
      try { parsed = JSON.parse(resumeContext) } catch { parsed = null }
    }
    const worktreePath: string | null = (parsed?.worktree_path as string) ?? null
    const sql = this.sql

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return await sql.begin(async (tx: any) => {
      const current = await tx`
        SELECT id, status, root_process_id, channel_id, skill_resource_id, name,
               parent_process_id, branch, training_resource_id, run_type, project_id
        FROM processes WHERE id = ${id}
      `
      if (current.length === 0) throw new Error(`Process not found: ${id}`)
      if (current[0].status !== 'active') {
        throw new Error(`Cannot sleep process ${id}: status must be 'active' but is '${current[0].status}'`)
      }

      const row = current[0] as {
        id: string
        root_process_id: string | null
        channel_id: string | null
        skill_resource_id: string | null
        name: string
        parent_process_id: string | null
        branch: string | null
        training_resource_id: string | null
        run_type: string | null
        project_id: string | null
      }

      const rootProcessId = row.root_process_id ?? row.id

      let rootName: string
      if (rootProcessId !== row.id) {
        const rootRows = await tx`SELECT name FROM processes WHERE id = ${rootProcessId}`
        rootName = rootRows.length > 0 ? (rootRows[0] as { name: string }).name : row.name
      } else {
        rootName = row.name
      }

      const countRows = await tx`SELECT COUNT(*)::int AS cnt FROM processes WHERE root_process_id = ${rootProcessId}`
      const segmentCount = (countRows[0] as { cnt: number }).cnt
      const newName = `${rootName}-s${segmentCount + 1}`

      const updated: { id: string }[] = await tx`
        UPDATE processes
        SET status = 'completed',
            completed_at = NOW(),
            channel_id = NULL,
            updated_at = NOW()
        WHERE id = ${id} AND status = 'active'
        RETURNING id
      `
      if (updated.length === 0) {
        throw new Error(`Cannot sleep process ${id}: status changed concurrently (no longer active)`)
      }

      const inserted: { id: string; resume_at: Date }[] = await tx`
        INSERT INTO processes (
          root_process_id, channel_id, skill_resource_id, name,
          parent_process_id, branch, training_resource_id,
          run_type, status, resume_at, resume_context, worktree_path,
          project_id
        ) VALUES (
          ${rootProcessId}, ${row.channel_id}, ${row.skill_resource_id}, ${newName},
          ${row.id}, ${row.branch}, ${row.training_resource_id},
          ${row.run_type}, 'waiting',
          (NOW() AT TIME ZONE 'UTC') + ${interval}::interval,
          ${resumeContext}, ${worktreePath},
          ${row.project_id}
        )
        RETURNING id, resume_at
      `

      return { resume_at: inserted[0].resume_at, new_segment_id: inserted[0].id }
    })
  }

  async claim(id: string): Promise<boolean> {
    const claimed: { id: string }[] = await this.sql`
      UPDATE processes
      SET status = 'active', started_at = NOW(), updated_at = NOW()
      WHERE id = ${id} AND status = 'waiting'
      RETURNING id
    `
    return claimed.length > 0
  }

  async restart(deadId: string): Promise<{ newId: string; originalProcess: ProcessRow }> {
    const sql = this.sql

    const dead = await this.getById(deadId)
    if (!dead) {
      throw new Error(`Process not found: ${deadId}`)
    }

    const RESTARTABLE = ['failed', 'completed', 'blocked']
    if (!RESTARTABLE.includes(dead.status)) {
      throw new Error(`Cannot restart process with status '${dead.status}': only failed, completed, or blocked processes can be restarted`)
    }

    const rootProcessId = dead.root_process_id ?? dead.id
    const newName = `${dead.name}-r${Date.now()}`

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const newId: string = await sql.begin(async (tx: any) => {
      let newRows: { id: string }[]
      if (dead.status === 'blocked') {
        newRows = await tx`
          INSERT INTO processes (name, parent_process_id, root_process_id, skill_resource_id, status, worktree_path)
          VALUES (${newName}, ${dead.id}, ${rootProcessId}, ${dead.skill_resource_id}, 'pending', ${dead.worktree_path})
          RETURNING id
        `
      } else {
        newRows = await tx`
          INSERT INTO processes (name, parent_process_id, root_process_id, skill_resource_id, status)
          VALUES (${newName}, ${dead.id}, ${rootProcessId}, ${dead.skill_resource_id}, 'pending')
          RETURNING id
        `
      }
      const id = newRows[0].id

      await this._insertAgentEvent(tx, {
        processId: dead.id,
        processName: dead.name,
        resourceId: dead.skill_resource_id,
        source: 'process_continued',
        payload: { new_process_id: id },
      })

      await this._insertAgentEvent(tx, {
        processId: id,
        processName: dead.name,
        resourceId: dead.skill_resource_id,
        source: 'process_born_from',
        payload: { dead_process_id: dead.id, epoch_number: String(dead.current_epoch ?? 0) },
      })

      return id
    })

    return { newId, originalProcess: dead }
  }

  async amend(
    id: string,
    appendText: string,
    opts: { skillResourceId: string; worktreePath: string; processName: string; goalContent: string },
  ): Promise<void> {
    const sql = this.sql
    const after = opts.goalContent + '\n' + appendText

    await sql`
      UPDATE resources
      SET config = jsonb_set(config, '{content}', to_jsonb(${after}::text))
      WHERE id = ${opts.skillResourceId}
    `

    await this._insertAgentEvent(sql, {
      processId: id,
      processName: opts.processName,
      resourceId: opts.skillResourceId,
      source: 'goal_amended',
      payload: { before: opts.goalContent, after },
    })
  }

  async resolveChain(rootProcessId: string): Promise<ProcessRow[]> {
    const rows = await this.sql`
      SELECT id, name, status, current_epoch, metrics, updated_at, started_at, completed_at, branch, training_resource_id, resume_at, worktree_path, resume_context, root_process_id, channel_id, skill_resource_id
      FROM processes
      WHERE root_process_id = ${rootProcessId} OR id = ${rootProcessId}
      ORDER BY created_at ASC
    `
    return rows as unknown as ProcessRow[]
  }

  async getEpochs(processId: string, limit = 10): Promise<EpochResultRow[]> {
    const rows: EpochResultRow[] = await this.sql`
      SELECT epoch_number, status, completed_at
      FROM epoch_results
      WHERE campaign_id = ${processId}
      ORDER BY epoch_number DESC
      LIMIT ${limit}
    `
    return rows
  }

  async upsertEpochResult(
    processId: string,
    epochNumber: number,
    data: Record<string, unknown>,
  ): Promise<void> {
    const now = new Date()
    // Pass object via sql.json() — postgres.js native JSON serialization produces JSONB object type.
    // JSON.stringify + ::jsonb causes double-encoding (stores as JSON string, not object).
    const stateSnapshot = data.state_snapshot !== undefined && data.state_snapshot !== null
      ? (data.state_snapshot as Record<string, unknown>)
      : null
    const startedAt = (data.started_at instanceof Date ? data.started_at :
      (typeof data.started_at === 'string' ? new Date(data.started_at) : null)) ?? now
    const cost = typeof data.cost === 'number' ? data.cost : null
    const durationMs = typeof data.duration_ms === 'number' ? data.duration_ms : null
    const sessionId = typeof data.session_id === 'string' ? data.session_id : null

    await this.sql`
      INSERT INTO epoch_results (campaign_id, epoch_number, status, state_snapshot, started_at, completed_at, cost, duration_ms, session_id)
      VALUES (${processId}, ${epochNumber}, 'completed', ${stateSnapshot ? this.sql.json(stateSnapshot as unknown as import('postgres').JSONValue) : null}, ${startedAt}, ${now}, ${cost}, ${durationMs}, ${sessionId})
      ON CONFLICT (campaign_id, epoch_number)
      DO UPDATE SET
        status = 'completed',
        state_snapshot = COALESCE(EXCLUDED.state_snapshot, epoch_results.state_snapshot),
        started_at = COALESCE(epoch_results.started_at, EXCLUDED.started_at),
        completed_at = EXCLUDED.completed_at,
        cost = COALESCE(EXCLUDED.cost, epoch_results.cost),
        duration_ms = COALESCE(EXCLUDED.duration_ms, epoch_results.duration_ms),
        session_id = COALESCE(EXCLUDED.session_id, epoch_results.session_id)
    `
  }

  async updateAggregate(processId: string, touchedEpochs: number[]): Promise<void> {
    const sql = this.sql
    const rows: { epoch_number: number }[] = await sql`
      SELECT epoch_number
      FROM epoch_results
      WHERE campaign_id = ${processId} AND status = 'completed'
      ORDER BY epoch_number ASC
    `

    if (rows.length === 0) return

    const completedEpochs = rows.map(r => r.epoch_number)
    const maxTouched = touchedEpochs.length > 0 ? Math.max(...touchedEpochs) : 0
    const newCurrentEpoch = Math.max(...completedEpochs, maxTouched)

    await sql`
      UPDATE processes
      SET current_epoch = ${newCurrentEpoch},
          updated_at = ${new Date()}
      WHERE id = ${processId}
    `
  }

  async updateFields(opts: { id?: string; name?: string; channelId?: string; worktreePath?: string }): Promise<string> {
    const sql = this.sql
    const updates: Record<string, unknown> = {}
    if (opts.channelId !== undefined) updates.channel_id = opts.channelId
    if (opts.worktreePath !== undefined) updates.worktree_path = opts.worktreePath
    if (Object.keys(updates).length === 0) {
      throw new Error('updateFields: at least one field (channelId or worktreePath) must be provided')
    }
    if (!opts.id && !opts.name) {
      throw new Error('updateFields: id or name must be provided')
    }
    const rows: { id: string }[] = opts.id
      ? await sql`UPDATE processes SET ${sql(updates)}, updated_at = NOW() WHERE id = ${opts.id} RETURNING id`
      : await sql`
    UPDATE processes
    SET ${sql(updates)}, updated_at = NOW()
    WHERE id = (
      SELECT id FROM processes WHERE name = ${opts.name!} ORDER BY updated_at DESC, id DESC LIMIT 1
    )
    RETURNING id
  `
    if (rows.length === 0) {
      const ref = opts.id ? `ID "${opts.id}"` : `name "${opts.name}"`
      throw new Error(`Process not found: ${ref}`)
    }
    return rows[0].id
  }

  async resolveTrainingSetId(trainingSetId: string): Promise<string> {
    const resolved: { id: string }[] = await this.sql`
      SELECT id FROM resources WHERE name = ${trainingSetId} AND type = 'data'
    `
    if (resolved.length === 0) {
      throw new Error(`No data resource found with name "${trainingSetId}"`)
    }
    return resolved[0].id
  }

  async block(id: string, reason: string, worktreePath?: string | null): Promise<void> {
    const sql = this.sql
    let rows: { id: string }[]
    if (worktreePath) {
      rows = await this._tryUpdateWithColumnFallback(
        () => sql`
          UPDATE processes
          SET status = 'blocked', worktree_path = ${worktreePath}, failure_reason = ${reason}, updated_at = NOW()
          WHERE id = ${id} AND status = 'active'
          RETURNING id
        `,
        () => sql`
          UPDATE processes
          SET status = 'blocked', worktree_path = ${worktreePath}, updated_at = NOW()
          WHERE id = ${id} AND status = 'active'
          RETURNING id
        `,
        'failure_reason',
      )
    } else {
      rows = await this._tryUpdateWithColumnFallback(
        () => sql`
          UPDATE processes
          SET status = 'blocked', failure_reason = ${reason}, updated_at = NOW()
          WHERE id = ${id} AND status = 'active'
          RETURNING id
        `,
        () => sql`
          UPDATE processes
          SET status = 'blocked', updated_at = NOW()
          WHERE id = ${id} AND status = 'active'
          RETURNING id
        `,
        'failure_reason',
      )
    }
    if (rows.length === 0) {
      const existing: { id: string; status: string }[] = await sql`SELECT id, status FROM processes WHERE id = ${id}`
      if (existing.length === 0) throw new Error(`Process not found: ${id}`)
      throw new Error(`Cannot block process ${id}: current status is ${existing[0].status} (only active processes can be blocked)`)
    }
  }

  async findWaitingProcesses(projectId?: string): Promise<WaitingProcessRow[]> {
    const sql = this.sql
    const rows: WaitingProcessRow[] = await sql`
      SELECT id, resume_context FROM processes
      WHERE status = 'waiting' AND resume_at <= NOW()
      ${projectId ? sql`AND project_id = ${projectId}` : sql``}
    `
    return rows
  }

  async findOrphanProcesses(cutoff: Date): Promise<OrphanProcessRow[]> {
    const rows: OrphanProcessRow[] = await this.sql`
      SELECT id, name, worktree_path FROM processes
      WHERE status = 'active' AND created_at < ${cutoff}
        AND id NOT IN (
          SELECT DISTINCT process_id FROM agent_events
          WHERE ts > ${cutoff} AND process_id IS NOT NULL
        )
    `
    return rows
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  private async _tryUpdateWithColumnFallback(
    primary: () => Promise<{ id: string }[]>,
    fallback: () => Promise<{ id: string }[]>,
    columnHint: string,
  ): Promise<{ id: string }[]> {
    try {
      return await primary()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (!(msg.includes(columnHint) && msg.includes('does not exist'))) throw err
      process.stderr.write(`[ProcessesService] WARNING: column '${columnHint}' does not exist — falling back to query without it. Run pending migrations to fix this.\n`)
      return fallback()
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async _insertAgentEvent(sql: any, args: {
    processId: string
    processName: string
    resourceId: string | null
    source: AgentEventSource
    payload: Record<string, unknown>
  }): Promise<void> {
    await sql`
      INSERT INTO agent_events (process_id, process_name, resource_id, source, payload)
      VALUES (${args.processId}, ${args.processName}, ${args.resourceId}, ${args.source}, ${sql.json(args.payload)})
    `
  }
}
