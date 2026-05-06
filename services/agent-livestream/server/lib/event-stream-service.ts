import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@skill-networks/logger'
import type { SseEventFrame } from '../../contracts/sse-event-frame.js'
import { BFF } from '../constants.js'
import { getServices } from './services.js'

const logger = createLogger('agent-livestream:sse-service')

export class ForbiddenError extends Error {
  readonly status = 403 as const
  constructor() {
    super('Forbidden')
    this.name = 'ForbiddenError'
  }
}

/**
 * Phase 1 — Authorization gate.
 * Resolves the user's authorized projects via ResourcesService (uses ProjectScopeService pattern).
 * Throws ForbiddenError if the user is not a member of `projectId`.
 * Called BEFORE the SSE stream is opened so the route handler can return 403 JSON.
 */
export async function authorizeProjectAccess(opts: {
  projectId: string
  userId: string
}): Promise<void> {
  const { projectId, userId } = opts
  const { resources } = getServices()
  const authorized = await resources.resolveUserProjects(userId)
  if (!authorized.has(projectId)) {
    throw new ForbiddenError()
  }
}

/**
 * Phase 2 — Stream lifecycle.
 * Subscribes to Supabase Realtime agent_events inserts scoped to the given project.
 * Each event is verified per-connection before being forwarded.
 * Returns a cleanup function — call it on client disconnect (ReadableStream.cancel).
 *
 * Authorization must be verified before calling this function (see authorizeProjectAccess).
 *
 * Note: authorization is checked once at connection open. If a user is removed from a project
 * mid-stream, the connection continues until the client disconnects. Acceptable for cursor
 * animation; tighten if access revocation SLA requires it.
 */
export function startProjectEventStream(opts: {
  projectId: string
  supabaseClient: SupabaseClient
  controller: ReadableStreamDefaultController
}): () => void {
  const { projectId, supabaseClient, controller } = opts
  const enc = new TextEncoder()

  // Per-connection Set: processIds confirmed to belong to this project.
  // NOT shared across connections — avoids cross-tenant data exposure.
  // Positive-only: once cached, a processId is trusted for the lifetime of this
  // connection — consistent with the connect-time authorization model above.
  // Negative results are not cached to handle creation races where a Realtime
  // INSERT fires before the process row is visible to a DB read.
  // Capped at SSE_PROCESS_CACHE_MAX — on a very long-lived connection the DB is
  // queried for uncached processes above the cap, which is safe and bounded.
  const processCache = new Set<string>()

  // Send initial heartbeat so the client knows the connection is live
  try {
    controller.enqueue(enc.encode(': heartbeat\n\n'))
  } catch (err) {
    logger.warn('Initial heartbeat enqueue failed — controller already closed', { projectId, error: err })
    return () => { /* no-op */ }
  }

  let cleaned = false

  const channel = supabaseClient
    // UUID suffix ensures distinct Realtime channels for concurrent subscribers
    // (e.g. multiple browser tabs on the same project).
    .channel(`sse_project_${projectId}_${crypto.randomUUID()}`)
    .on(
      'postgres_changes' as const,
      {
        event: 'INSERT',
        schema: 'public',
        table: 'agent_events',
      },
      async (changePayload: { new: Record<string, unknown> }) => {
        const row = changePayload.new
        const processId = typeof row['process_id'] === 'string' ? row['process_id'] : undefined
        if (!processId) return

        // Verify the event's process belongs to the requested project.
        // Per-connection cache avoids repeated DB lookups within one connection.
        if (!processCache.has(processId)) {
          try {
            const proc = await getServices().processes.getById(processId)
            if (proc?.project_id !== projectId) {
              return // not this project — skip without caching (creation race safety)
            }
            if (processCache.size < BFF.SSE_PROCESS_CACHE_MAX) {
              processCache.add(processId)
            }
            // If cache is full, still forward the event — just skip caching
          } catch (err) {
            logger.warn('Failed to verify process ownership for SSE event', { processId, error: err })
            return
          }
        }

        if (cleaned) return // connection already torn down while awaiting getById

        const source = typeof row['source'] === 'string' ? row['source'] : 'unknown'

        // Extract total_tokens from token_usage events for cursor impulse scaling
        let tokens: number | undefined
        if (source === 'token_usage') {
          const payload = row['payload'] as Record<string, unknown> | null | undefined
          const raw = payload?.['total_tokens']
          if (typeof raw === 'number' && raw > 0) tokens = raw
        }

        const frame: SseEventFrame = {
          source,
          process_id: processId,
          ts: typeof row['ts'] === 'string' ? row['ts'] : new Date().toISOString(),
          ...(tokens !== undefined && { tokens }),
        }

        try {
          controller.enqueue(enc.encode(`data: ${JSON.stringify(frame)}\n\n`))
        } catch {
          // controller closed — client disconnected; tear down promptly
          doCleanup()
        }
      }
    )
    .subscribe((status: string) => {
      logger.debug('Realtime channel status', { projectId, status })
      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        logger.warn('Realtime channel error — tearing down SSE stream', { projectId, status })
        doCleanup()
      }
    })

  // Periodic heartbeat — keeps proxies (Cloudflare, nginx, ALB) from timing out idle connections
  const heartbeatTimer = setInterval(() => {
    try {
      controller.enqueue(enc.encode(': heartbeat\n\n'))
    } catch {
      doCleanup()
    }
  }, BFF.SSE_HEARTBEAT_INTERVAL_MS)

  function doCleanup(): void {
    if (cleaned) return
    cleaned = true
    clearInterval(heartbeatTimer)
    supabaseClient.removeChannel(channel).catch((err: unknown) => {
      logger.warn('Failed to remove realtime channel on cleanup', {
        projectId,
        topic: channel.topic,
        error: err,
      })
    })
  }

  return doCleanup
}
