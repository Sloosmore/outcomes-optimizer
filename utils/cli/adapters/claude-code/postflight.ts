import { existsSync, readdirSync, statSync, readFileSync } from 'fs'
import { resolve, join } from 'path'
import { homedir } from 'os'
import type { PostflightHook, PostflightContext } from '../../types.js'
import { isDatabaseEnabled, getDb, closeDb } from '../../../database/client.js'
import { traces } from '../../../database/schema.js'
import { isStorageEnabled, uploadTrace } from '../../../database/storage.js'

function findTraceFile(sessionId: string): string | null {
  const claudeDir = resolve(homedir(), '.claude', 'projects')
  if (!existsSync(claudeDir)) return null
  try {
    for (const projectDir of readdirSync(claudeDir)) {
      const projectPath = join(claudeDir, projectDir)
      if (!statSync(projectPath).isDirectory()) continue
      const traceFile = join(projectPath, `${sessionId}.jsonl`)
      if (existsSync(traceFile)) return traceFile
    }
  } catch (err) {
    console.error(`[postflight] Error reading projects directory: ${(err as Error).message}`)
  }
  return null
}

/**
 * Postflight hook that records trace metadata to the database and/or uploads
 * the trace file to Supabase Storage.
 * - DB insert runs only when isDatabaseEnabled(); captures trace UUID for tag attachment
 * - Storage upload runs only when isStorageEnabled()
 * - Tag attachment requires both DB (for the trace UUID) and storage to be enabled
 */
export const traceRecordHook: PostflightHook = {
  name: 'claude-code:trace-record',

  async run(context: PostflightContext): Promise<void> {
    if (context.adapter !== 'claude-code') return
    if (!isDatabaseEnabled() && !isStorageEnabled()) return

    const tracePath = findTraceFile(context.sessionId)
    if (!tracePath) {
      console.error(`[postflight] Trace file not found for session: ${context.sessionId}`)
      return
    }

    let traceId: string | undefined

    try {
      if (isDatabaseEnabled()) {
        try {
          const db = getDb()
          const [inserted] = await db.insert(traces).values({
            sessionId: context.sessionId,
            startedAt: new Date(),
            filePath: tracePath,
            cost: context.cost?.toString(),
            durationMs: context.durationMs?.toString(),
          }).onConflictDoUpdate({
            target: traces.sessionId,
            set: {
              filePath: tracePath,
              cost: context.cost?.toString(),
              durationMs: context.durationMs?.toString(),
              endedAt: new Date(),
            }
          }).returning({ id: traces.id })
          traceId = inserted?.id
          if (!traceId) {
            console.warn(`[postflight] upsert returned no ID — tag attachment skipped (sessionId: ${context.sessionId})`)
          }
        } catch (err) {
          console.error(`[postflight] DB insert failed: ${(err as Error).message}`)
        }
      }

      if (isStorageEnabled()) {
        try {
          const content = readFileSync(tracePath, 'utf-8')
          const storagePath = await uploadTrace(context.sessionId, content)
          if (storagePath) {
            console.log(`[postflight] Trace uploaded to storage: ${storagePath}`)
            if (isDatabaseEnabled() && traceId) {
              try {
                const { upsertTag, attachTag } = await import('../../../database/tags.js')
                const tag = await upsertTag('skill:run')
                await attachTag(traceId, 'trace', tag.id)
              } catch (err) {
                console.error(`[postflight] Tag attachment failed: ${(err as Error).message}`)
              }
            }
          }
        } catch (err) {
          console.error(`[postflight] Failed to upload trace: ${(err as Error).message}`)
        }
      }
    } finally {
      if (isDatabaseEnabled()) {
        await closeDb()
      }
    }
  },
}
