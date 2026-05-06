import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import { execSync } from 'child_process'
import { createWatchdog } from '../watchdog.js'
import { SupabaseEventEmitterAdapter } from '../adapters/supabase-event-emitter.js'

const RUN_INTEGRATION = process.env.RUN_INTEGRATION === 'true'

const CWD = process.env.AGENT_CORE_CWD ?? process.cwd()

// Lazy initialization — only create client when integration tests run
// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
let supabase!: ReturnType<typeof createClient>

if (RUN_INTEGRATION) {
  supabase = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_KEY!
  )
}

function createTestProcess(suffix: string): string {
  const result = execSync(
    `npx agent-core process init --name "e2e-watchdog-${suffix}" --unlinked --json`,
    { cwd: CWD, encoding: 'utf8' }
  )
  const { id } = JSON.parse(result.trim())
  execSync(`npx agent-core process active --id "${id}"`, { cwd: CWD })
  return id
}

interface AgentEvent {
  id: string
  source: string
  payload: Record<string, unknown>
  ts: string
}

async function queryStaleEvents(uuid: string): Promise<AgentEvent[]> {
  const { data } = await supabase
    .from('agent_events')
    .select('id, source, payload, ts')
    .eq('process_id', uuid)
    .eq('source', 'process:stale')
  return (data as AgentEvent[]) ?? []
}

async function queryEventCount(uuid: string, source: string) {
  const { count } = await supabase
    .from('agent_events')
    .select('*', { count: 'exact', head: true })
    .eq('process_id', uuid)
    .eq('source', source)
  return count ?? 0
}

async function cleanupProcess(uuid: string) {
  execSync(`npx agent-core process fail --id "${uuid}"`, {
    cwd: CWD,
    stdio: 'ignore'
  })
  await supabase.from('agent_events').delete().eq('process_id', uuid)
}

function saveEnv(...keys: string[]): () => void {
  const saved: Record<string, string | undefined> = {}
  for (const k of keys) saved[k] = process.env[k]
  return () => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  }
}

describe.skipIf(!RUN_INTEGRATION)('watchdog E2E integration tests', () => {
  // -------------------------------------------------------------------------
  // Test 1: PROCESS_STALE event emitted on silence
  // -------------------------------------------------------------------------
  describe('Test 1: PROCESS_STALE event emitted on silence', () => {
    const suffix = `silence-${Date.now()}`
    let uuid: string
    let watchdog: { stop(): void }
    const testStart = Date.now()
    let restoreEnv: () => void

    beforeAll(() => {
      restoreEnv = saveEnv('EVAL_PROCESS_ID', 'EVAL_PROCESS')
      uuid = createTestProcess(suffix)
      process.env.EVAL_PROCESS_ID = uuid
      process.env.EVAL_PROCESS = `e2e-watchdog-${suffix}`
      watchdog = createWatchdog(uuid, 10000)
    })

    afterAll(async () => {
      watchdog.stop()
      restoreEnv()
      await cleanupProcess(uuid)
    })

    it(
      'emits exactly 1 process:stale row after 10s silence',
      async () => {
        // Wait 15s — threshold is 10s so stale event should have fired
        await new Promise(resolve => setTimeout(resolve, 15000))

        const staleEvents = await queryStaleEvents(uuid)

        expect(staleEvents).toHaveLength(1)
        expect(staleEvents[0].source).toBe('process:stale')
        expect(staleEvents[0].payload).toMatchObject({
          process_id: uuid,
          threshold_ms: 10000
        })

        const eventTs = new Date(staleEvents[0].ts).getTime()
        expect(eventTs).toBeGreaterThanOrEqual(testStart)
        expect(eventTs).toBeLessThanOrEqual(testStart + 15000 + 2000)
      },
      30000
    )
  })

  // -------------------------------------------------------------------------
  // Test 2: Timer resets on activity — no stale event while active
  // -------------------------------------------------------------------------
  describe('Test 2: Timer resets on activity — no stale event while active', () => {
    const suffix = `active-${Date.now()}`
    let uuid: string
    let watchdog: { stop(): void }
    let restoreEnv: () => void

    beforeAll(() => {
      restoreEnv = saveEnv('EVAL_PROCESS_ID', 'EVAL_PROCESS')
      uuid = createTestProcess(suffix)
      process.env.EVAL_PROCESS_ID = uuid
      process.env.EVAL_PROCESS = `e2e-watchdog-${suffix}`
      watchdog = createWatchdog(uuid, 10000)
    })

    afterAll(async () => {
      watchdog.stop()
      restoreEnv()
      await cleanupProcess(uuid)
    })

    it(
      'no stale event emitted when keepalives arrive every 3s over 25s',
      async () => {
        const emitter = new SupabaseEventEmitterAdapter(
          process.env.SUPABASE_URL!,
          process.env.SUPABASE_SERVICE_KEY!
        )

        // Wait ~2-3s for realtime subscription to connect before emitting
        await new Promise(resolve => setTimeout(resolve, 3000))

        // Emit keepalives every 3s for 25s (8-9 events total)
        const totalDuration = 25000
        const interval = 3000
        let elapsed = 0
        let i = 0

        while (elapsed < totalDuration) {
          emitter.emit({
            source: 'epoch:end',
            payload: { epoch: i, keepalive: true },
            resource_id: null,
            process_id: uuid,
            process_name: `e2e-watchdog-${suffix}`
          })
          i++
          await new Promise(resolve => setTimeout(resolve, interval))
          elapsed += interval
        }

        const staleCount = await queryEventCount(uuid, 'process:stale')
        expect(staleCount).toBe(0)

        const epochCount = await queryEventCount(uuid, 'epoch:end')
        expect(epochCount).toBeGreaterThanOrEqual(8)
      },
      40000
    )
  })

  // -------------------------------------------------------------------------
  // Test 3: Stale event fires after activity stops
  // -------------------------------------------------------------------------
  describe('Test 3: Stale event fires after activity stops', () => {
    const suffix = `stops-${Date.now()}`
    let uuid: string
    let watchdog: { stop(): void }
    let restoreEnv: () => void

    beforeAll(() => {
      restoreEnv = saveEnv('EVAL_PROCESS_ID', 'EVAL_PROCESS')
      uuid = createTestProcess(suffix)
      process.env.EVAL_PROCESS_ID = uuid
      process.env.EVAL_PROCESS = `e2e-watchdog-${suffix}`
      watchdog = createWatchdog(uuid, 10000)
    })

    afterAll(async () => {
      watchdog.stop()
      restoreEnv()
      await cleanupProcess(uuid)
    })

    it(
      'stale event fires ~10s after keepalives stop',
      async () => {
        const emitter = new SupabaseEventEmitterAdapter(
          process.env.SUPABASE_URL!,
          process.env.SUPABASE_SERVICE_KEY!
        )

        // Wait ~3s for realtime subscription to connect
        await new Promise(resolve => setTimeout(resolve, 3000))

        // Emit keepalive every 3s for 15s (5 events)
        let lastKeepaliveTs = 0
        for (let i = 0; i < 5; i++) {
          emitter.emit({
            source: 'epoch:end',
            payload: { epoch: i, keepalive: true },
            resource_id: null,
            process_id: uuid,
            process_name: `e2e-watchdog-${suffix}`
          })
          lastKeepaliveTs = Date.now()
          await new Promise(resolve => setTimeout(resolve, 3000))
        }

        // No more keepalives — wait 15s for stale to fire
        await new Promise(resolve => setTimeout(resolve, 15000))

        const staleEvents = await queryStaleEvents(uuid)
        expect(staleEvents).toHaveLength(1)

        const staleTs = new Date(staleEvents[0].ts).getTime()
        // stale event should be at least 10s after the last keepalive
        expect(staleTs).toBeGreaterThanOrEqual(lastKeepaliveTs + 10000)
      },
      45000
    )
  })

  // -------------------------------------------------------------------------
  // Test 4: watchdog.stop() prevents stale emission
  // -------------------------------------------------------------------------
  describe('Test 4: watchdog.stop() prevents stale emission', () => {
    const suffix = `stopped-${Date.now()}`
    let uuid: string
    let watchdog: { stop(): void }
    let restoreEnv: () => void

    beforeAll(() => {
      restoreEnv = saveEnv('EVAL_PROCESS_ID', 'EVAL_PROCESS')
      uuid = createTestProcess(suffix)
      process.env.EVAL_PROCESS_ID = uuid
      process.env.EVAL_PROCESS = `e2e-watchdog-${suffix}`
      watchdog = createWatchdog(uuid, 10000)
    })

    afterAll(async () => {
      restoreEnv()
      await cleanupProcess(uuid)
    })

    it(
      'no stale event emitted after stop() is called before threshold',
      async () => {
        // Wait 5s (less than 10s threshold)
        await new Promise(resolve => setTimeout(resolve, 5000))

        // Stop the watchdog before the threshold fires
        watchdog.stop()

        // Wait 10s more — past the original threshold
        await new Promise(resolve => setTimeout(resolve, 10000))

        const staleCount = await queryEventCount(uuid, 'process:stale')
        expect(staleCount).toBe(0)
      },
      25000
    )
  })
})
