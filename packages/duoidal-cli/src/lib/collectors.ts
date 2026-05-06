import diagnostics_channel from 'node:diagnostics_channel'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const ALL_CHANNELS = ['skill-networks:auth', 'skill-networks:db', 'skill-networks:scope', 'skill-networks:command']

export function registerNullCollector(): void {
  // No-op: no subscribers registered. Zero overhead.
}

export function registerTraceFileCollector(commandSlug: string): void {
  const dir = path.join(os.homedir(), '.duoidal', 'traces')
  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch (err) {
    process.stderr.write(`[trace] Failed to create trace directory: ${err instanceof Error ? err.message : err}\n`)
    return
  }
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const file = path.join(dir, `${commandSlug}-${timestamp}.jsonl`)
  let warnedWriteFailure = false
  for (const channelName of ALL_CHANNELS) {
    try {
      diagnostics_channel.subscribe(channelName, (event: unknown) => {
        try {
          fs.appendFileSync(file, JSON.stringify(event) + '\n')
        } catch (err) {
          if (!warnedWriteFailure) {
            warnedWriteFailure = true
            process.stderr.write(`[trace] Failed to write trace file: ${err instanceof Error ? err.message : err}\n`)
          }
        }
      })
    } catch {}
  }
}

export function registerStderrCollector(): void {
  for (const channelName of ALL_CHANNELS) {
    try {
      diagnostics_channel.subscribe(channelName, (event: unknown) => {
        try {
          process.stderr.write(JSON.stringify(event) + '\n')
        } catch {}
      })
    } catch {}
  }
}
