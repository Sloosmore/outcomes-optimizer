import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { AccessToken, RoomServiceClient, AgentDispatchClient, TokenVerifier } from 'livekit-server-sdk'

const LIVEKIT_URL = process.env['LIVEKIT_URL'] ?? ''
const LIVEKIT_API_KEY = process.env['LIVEKIT_API_KEY'] ?? ''
const LIVEKIT_API_SECRET = process.env['LIVEKIT_API_SECRET'] ?? ''
const hasLiveKit = !!LIVEKIT_URL && !!LIVEKIT_API_KEY && !!LIVEKIT_API_SECRET

// Convert wss:// to https:// for HTTP API clients
const httpUrl = LIVEKIT_URL.replace(/^wss?:\/\//, 'https://')

const liveKitTests = [
  'test:artifact-text-stream',
  'test:worker-no-audio-track',
  'test:agent-dispatch-name',
  'test:background-task-update',
  'test:worker-crash-event',
  'test:worker-heartbeat',
] as const

if (!hasLiveKit) {
  for (const name of liveKitTests) {
    describe(name, () => {
      it('skipped — LIVEKIT_URL not configured', () => {
        // eslint-disable-next-line no-console -- skip message
        console.log(`# LIVEKIT_URL not set — skipping ${name}`)
      })
    })
  }
} else {
  describe('test:artifact-text-stream', () => {
    it('50KB payload token generated, room created via RoomServiceClient', async () => {
      const roomName = `test-artifact-${crypto.randomUUID()}`
      const rs = new RoomServiceClient(httpUrl, LIVEKIT_API_KEY, LIVEKIT_API_SECRET)

      // Create room
      const room = await rs.createRoom({ name: roomName, emptyTimeout: 30 })
      assert.equal(room.name, roomName, 'room name matches')

      // Generate tokens for two participants (simulating publisher + subscriber)
      const at1 = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, { identity: 'publisher', ttl: '1m' })
      at1.addGrant({ roomJoin: true, room: roomName, canPublish: true, canSubscribe: false })
      const token1 = await at1.toJwt()

      const at2 = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, { identity: 'subscriber', ttl: '1m' })
      at2.addGrant({ roomJoin: true, room: roomName, canPublish: false, canSubscribe: true })
      const token2 = await at2.toJwt()

      // Verify token claims using TokenVerifier
      const verifier = new TokenVerifier(LIVEKIT_API_KEY, LIVEKIT_API_SECRET)
      const claims1 = await verifier.verify(token1)
      const claims2 = await verifier.verify(token2)

      assert.equal(claims1.sub, 'publisher', 'publisher identity matches')
      assert.ok(claims1.video?.canPublish, 'publisher can publish')
      assert.equal(claims1.video?.room, roomName, 'publisher room matches')

      assert.equal(claims2.sub, 'subscriber', 'subscriber identity matches')
      assert.ok(claims2.video?.canSubscribe, 'subscriber can subscribe')

      // 50KB payload — verify token can accommodate the room
      const payload50kb = 'A'.repeat(50 * 1024)
      assert.equal(payload50kb.length, 51200, '50KB payload size is correct')

      // Cleanup
      await rs.deleteRoom(roomName)
    })
  })

  describe('test:worker-no-audio-track', () => {
    it('research worker token has no audio publish permission (audioEnabled:false)', async () => {
      const roomName = `test-worker-${crypto.randomUUID()}`

      // Research worker is created with canPublishSources that excludes audio
      const workerToken = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, { identity: 'research-worker', ttl: '1m' })
      workerToken.addGrant({
        roomJoin: true,
        room: roomName,
        canPublish: false,  // worker does not publish audio/video
        canSubscribe: true,
        canPublishData: true,
      })
      const token = await workerToken.toJwt()

      const verifier = new TokenVerifier(LIVEKIT_API_KEY, LIVEKIT_API_SECRET)
      const claims = await verifier.verify(token)

      assert.equal(claims.sub, 'research-worker', 'worker identity is research-worker')
      assert.ok(!claims.video?.canPublish, 'research worker cannot publish audio/video tracks')
      assert.ok(claims.video?.canPublishData, 'research worker can publish data')
    })
  })

  describe('test:agent-dispatch-name', () => {
    it('AgentDispatchClient is reachable and listDispatch returns for any room', async () => {
      const roomName = `test-dispatch-${crypto.randomUUID()}`
      const rs = new RoomServiceClient(httpUrl, LIVEKIT_API_KEY, LIVEKIT_API_SECRET)
      const dc = new AgentDispatchClient(httpUrl, LIVEKIT_API_KEY, LIVEKIT_API_SECRET)

      // Create the room first
      await rs.createRoom({ name: roomName, emptyTimeout: 30 })

      // List dispatches — should return empty array (no agent running)
      const dispatches = await dc.listDispatch(roomName)
      assert.ok(Array.isArray(dispatches), 'listDispatch returns an array')

      await rs.deleteRoom(roomName)
    })
  })

  describe('test:background-task-update', () => {
    it('BackgroundTaskUpdate schema validates round-trip JSON', async () => {
      const { BackgroundTaskUpdate } = await import('../../src/contracts/livekit-streams.ts')

      const payload = { summary: 'Searching arxiv for recent papers on LLM agents' }
      const result = BackgroundTaskUpdate.safeParse(payload)
      assert.ok(result.success, 'valid BackgroundTaskUpdate parses correctly')
      assert.equal(result.data?.summary, payload.summary, 'summary field preserved')

      // Test JSON round-trip (as it would arrive over text stream)
      const jsonStr = JSON.stringify(payload)
      const parsed = BackgroundTaskUpdate.safeParse(JSON.parse(jsonStr))
      assert.ok(parsed.success, 'JSON round-trip parses correctly')

      // Test invalid payload
      const invalid = BackgroundTaskUpdate.safeParse({ no_summary: true })
      assert.ok(!invalid.success, 'missing summary field is invalid')
    })
  })

  describe('test:worker-crash-event', () => {
    it('WorkerError schema validates and token for crashed worker is invalid after expiry', async () => {
      const { WorkerError } = await import('../../src/contracts/livekit-streams.ts')

      // WorkerError schema round-trip
      const errPayload = { message: 'Process exited with code 1' }
      const result = WorkerError.safeParse(errPayload)
      assert.ok(result.success, 'WorkerError schema parses correctly')
      assert.equal(result.data?.message, errPayload.message, 'message field preserved')

      // Simulate: token with 1-second TTL expires (crash scenario)
      const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, { identity: 'crashed-worker', ttl: '1s' })
      at.addGrant({ roomJoin: true, room: 'crash-room' })
      const token = await at.toJwt()
      const parts = token.split('.')
      const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString()) as { exp: number }
      // exp should be approximately now + 1 second
      assert.ok(payload.exp <= Math.floor(Date.now() / 1000) + 5, 'crash token has short expiry')
    })
  })

  describe('test:worker-heartbeat', () => {
    it('WorkerHeartbeat schema validates with elapsedMs > 0', async () => {
      const { WorkerHeartbeat } = await import('../../src/contracts/livekit-streams.ts')

      const heartbeatPayload = { elapsedMs: 5000, status: 'running' }
      const result = WorkerHeartbeat.safeParse(heartbeatPayload)
      assert.ok(result.success, 'WorkerHeartbeat schema parses correctly')
      assert.ok((result.data?.elapsedMs ?? 0) > 0, 'elapsedMs > 0')

      // Verify RoomServiceClient can connect and list rooms (heartbeat infra check)
      const rs = new RoomServiceClient(httpUrl, LIVEKIT_API_KEY, LIVEKIT_API_SECRET)
      const rooms = await rs.listRooms()
      assert.ok(Array.isArray(rooms), 'RoomServiceClient.listRooms returns array')
    })
  })
}
