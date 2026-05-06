/**
 * SSE streaming integration tests + BFF boot verification.
 *
 * Tests 1-3: Real SSE against /api/events with Supabase Realtime (no mocking).
 * Tests 4-5: Chat-stream SSE against /api/chat with real Anthropic API (haiku).
 * Test 6:   BFF health endpoint boot verification.
 *
 * Run with:
 *   RUN_INTEGRATION=true BFF_DEV_TOKEN=<token> DATABASE_URL=<url> \
 *   npx vitest run sse-streaming
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { getSqlClient } from '@skill-networks/database/client'
import { closeDb } from '@skill-networks/database/drizzle'

const RUN_INTEGRATION = !!process.env['RUN_INTEGRATION']
const BFF_URL = process.env['BFF_URL'] ?? 'http://localhost:3001'
const TOKEN = process.env['BFF_DEV_TOKEN'] ?? ''

const authHeaders = { 'Authorization': `Bearer ${TOKEN}` }

// Shared state for test 4 -> test 5 dependency
let capturedChatId: string | undefined

// Track test data that needs cleanup
const testEventIds: string[] = []

// Warm-up SSE connection: keeps the Supabase Realtime WebSocket alive for the test suite.
// Without this, each individual SSE connection has to re-establish the WS connection,
// which may cause a brief window after SUBSCRIBED where WAL events are missed.
let warmupController: AbortController | undefined

beforeAll(async () => {
  if (!RUN_INTEGRATION) return
  warmupController = new AbortController()
  const warmupResp = await fetch(`${BFF_URL}/api/events`, {
    headers: authHeaders,
    signal: warmupController.signal,
  })
  // Wait for the warmup heartbeat to confirm Realtime is active
  if (warmupResp.ok) {
    const reader = warmupResp.body!.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      if (buf.includes(': heartbeat')) { reader.releaseLock(); break }
    }
  }
})

afterAll(async () => {
  warmupController?.abort()
  if (testEventIds.length > 0) {
    try {
      const sql = getSqlClient()
      await sql`DELETE FROM agent_events WHERE id = ANY(${sql.array(testEventIds)})`
    } catch {
      // Best-effort cleanup
    }
  }
  await closeDb()
})

/**
 * Read SSE frames from a fetch Response body.
 * Yields each complete frame (text between double newlines).
 */
async function* readSSEFrames(
  response: Response,
  signal: AbortSignal,
): AsyncGenerator<string> {
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })

      let boundary: number
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        if (frame.length > 0) yield frame
      }
    }
  } finally {
    reader.releaseLock()
  }
}

/** Parse a `data: <json>` SSE frame into an object, or return the raw string. */
function parseDataFrame(frame: string): unknown | null {
  const match = frame.match(/^data: (.+)$/m)
  if (!match) return null
  try {
    return JSON.parse(match[1])
  } catch {
    return match[1]
  }
}

describe.skipIf(!RUN_INTEGRATION)('SSE streaming integration', () => {

  it('1. SSE heartbeat arrives within 1000ms', { timeout: 5000 }, async () => {
    const controller = new AbortController()

    const response = await fetch(`${BFF_URL}/api/events`, {
      headers: authHeaders,
      signal: controller.signal,
    })

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')

    const startTime = Date.now()
    let receivedHeartbeat = false

    for await (const frame of readSSEFrames(response, controller.signal)) {
      if (frame.startsWith(': heartbeat')) {
        receivedHeartbeat = true
        break
      }
    }

    controller.abort()

    const elapsed = Date.now() - startTime
    expect(receivedHeartbeat).toBe(true)
    expect(elapsed).toBeLessThan(1000)
  })

  it('2. SSE delivers events inserted into agent_events', { timeout: 20000 }, async () => {
    const controller = new AbortController()
    const testProcessId = crypto.randomUUID()
    const testSource = 'sse_test_marker'

    const response = await fetch(`${BFF_URL}/api/events`, {
      headers: authHeaders,
      signal: controller.signal,
    })
    expect(response.status).toBe(200)

    let receivedHeartbeat = false
    let receivedTestEvent = false

    // Use a resolver to decouple heartbeat detection from the insert.
    // The for-await loop must not be blocked by the SQL insert — it needs to
    // keep reading frames so the SSE event is not missed while the loop is
    // awaiting an unrelated promise.
    let triggerInsert: () => void = () => {}
    const heartbeatDetected = new Promise<void>((resolve) => { triggerInsert = resolve })

    // Start the DB insert as a parallel promise, triggered when heartbeat arrives.
    const insertPromise = heartbeatDetected.then(async () => {
      const sql = getSqlClient()
      const [inserted] = await sql`
        INSERT INTO agent_events (process_id, process_name, source, payload)
        VALUES (${testProcessId}, ${'sse_test_process'}, ${testSource}, ${JSON.stringify({ marker: true })}::jsonb)
        RETURNING id
      `
      testEventIds.push(inserted.id)
    })

    const eventPromise = (async () => {
      for await (const frame of readSSEFrames(response, controller.signal)) {
        if (frame.startsWith(': heartbeat')) {
          receivedHeartbeat = true
          // Signal the parallel insert to start — do NOT await here.
          // Awaiting inside for-await blocks the generator from reading new frames.
          // Brief delay ensures the Realtime subscription is fully active before insert.
          setTimeout(triggerInsert, 500)
          continue
        }

        const parsed = parseDataFrame(frame)
        if (
          parsed !== null &&
          typeof parsed === 'object' &&
          (parsed as Record<string, unknown>)['process_id'] === testProcessId &&
          (parsed as Record<string, unknown>)['source'] === testSource
        ) {
          receivedTestEvent = true
          break
        }
      }
    })()

    const timeout = new Promise<void>((_, reject) =>
      setTimeout(() => reject(new Error('Timed out waiting for SSE event')), 15000),
    )

    try {
      await Promise.race([eventPromise, timeout])
    } finally {
      controller.abort()
    }

    // Ensure the insert also completed (even if we got the event before the insert promise resolved)
    await insertPromise.catch(() => { /* best-effort */ })

    expect(receivedHeartbeat).toBe(true)
    expect(receivedTestEvent).toBe(true)
  })

  it('3. SSE reconnects cleanly after disconnect (no orphaned channels)', { timeout: 10000 }, async () => {
    // First connection
    const controller1 = new AbortController()
    const response1 = await fetch(`${BFF_URL}/api/events`, {
      headers: authHeaders,
      signal: controller1.signal,
    })
    expect(response1.status).toBe(200)

    for await (const frame of readSSEFrames(response1, controller1.signal)) {
      if (frame.startsWith(': heartbeat')) break
    }

    controller1.abort()

    // Wait for server-side cleanup
    await new Promise((resolve) => setTimeout(resolve, 2000))

    // Second connection
    const controller2 = new AbortController()
    const response2 = await fetch(`${BFF_URL}/api/events`, {
      headers: authHeaders,
      signal: controller2.signal,
    })
    expect(response2.status).toBe(200)

    const startTime = Date.now()
    let receivedHeartbeat = false

    for await (const frame of readSSEFrames(response2, controller2.signal)) {
      if (frame.startsWith(': heartbeat')) {
        receivedHeartbeat = true
        break
      }
    }

    controller2.abort()

    const elapsed = Date.now() - startTime
    expect(receivedHeartbeat).toBe(true)
    expect(elapsed).toBeLessThan(1000)
  })

  it('4. POST /api/chat returns SSE with RUN_STARTED, TEXT_MESSAGE_CONTENT, [DONE]', { timeout: 30000 }, async () => {
    const response = await fetch(`${BFF_URL}/api/chat`, {
      method: 'POST',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chatId: 'new',
        messages: [{ role: 'user', content: 'Say hello in one word' }],
      }),
    })

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')

    let hasRunStarted = false
    let hasTextContent = false
    let hasDone = false
    let threadId: string | undefined

    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })

        let boundary: number
        while ((boundary = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)
          if (frame.length === 0) continue

          const parsed = parseDataFrame(frame)

          if (typeof parsed === 'object' && parsed !== null) {
            const event = parsed as Record<string, unknown>
            if (event['type'] === 'RUN_STARTED') {
              hasRunStarted = true
              threadId = event['threadId'] as string
            } else if (event['type'] === 'TEXT_MESSAGE_CONTENT') {
              hasTextContent = true
            }
          } else if (parsed === '[DONE]') {
            hasDone = true
          }
        }
      }
    } finally {
      reader.releaseLock()
    }

    expect(hasRunStarted).toBe(true)
    expect(hasTextContent).toBe(true)
    expect(hasDone).toBe(true)
    expect(threadId).toBeDefined()

    capturedChatId = threadId
  })

  it('5. Chat messages are persisted to DB after streaming', { timeout: 10000 }, async () => {
    expect(capturedChatId).toBeDefined()

    const response = await fetch(`${BFF_URL}/api/chats/${capturedChatId}/messages`, {
      headers: authHeaders,
    })

    expect(response.status).toBe(200)

    const messages = await response.json() as Array<{
      id: string
      chatId: string
      role: string
      content: string
      createdAt: string
    }>

    expect(Array.isArray(messages)).toBe(true)

    const assistantMessages = messages.filter((m) => m.role === 'assistant')
    expect(assistantMessages.length).toBeGreaterThanOrEqual(1)

    for (const msg of assistantMessages) {
      expect(msg.content.length).toBeGreaterThan(0)
    }
  })
})

describe.skipIf(!RUN_INTEGRATION)('BFF boot verification', () => {
  it('6. GET /health returns 200', { timeout: 5000 }, async () => {
    const response = await fetch(`${BFF_URL}/health`)

    expect(response.status).toBe(200)

    const body = await response.json() as Record<string, unknown>
    expect(body).toBeDefined()
    expect(body['version']).toBeDefined()
  })
})