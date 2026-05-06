#!/usr/bin/env tsx
/**
 * LiveKit direct test harness.
 *
 * Bypasses the Vercel UI:
 *   1. mints a voiceToolJwt for the given Supabase user_id
 *   2. creates a fresh LiveKit room (room-<uuid>) with that JWT in metadata
 *   3. dispatches the named voice-agent into the room
 *   4. joins the room as a tester participant
 *   5. injects a text turn over the lk.chat topic
 *   6. prints every text-stream and data-channel event the agent emits
 *
 * Usage:
 *   doppler run --project <your-project> --config <your-config> -- \
 *     pnpm exec tsx tests/livekit-direct/harness.mts \
 *     --user-id 25337a89-cde3-4808-be8a-a576fb46a307 \
 *     --prompt "research the architecture of the codebase"
 *
 * Required env (from doppler):
 *   LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET, VOICE_TOOL_JWT_SECRET
 */
import { AccessToken, RoomServiceClient, AgentDispatchClient } from 'livekit-server-sdk'
import { Room, RoomEvent } from '@livekit/rtc-node'
import { randomUUID } from 'node:crypto'
import { mintVoiceToolJwt } from '../../server/lib/voice-tool-jwt.js'

interface Args {
  userId: string
  prompt: string
  identity: string
  durationMs: number
  agentName: string
}

function parseArgs(): Args {
  const a = process.argv.slice(2)
  const get = (k: string) => {
    const i = a.indexOf(k)
    return i >= 0 ? a[i + 1] : undefined
  }
  const userId = get('--user-id')
  const prompt = get('--prompt') ?? 'research the architecture of the codebase'
  const identity = get('--identity') ?? `tester-${Math.random().toString(36).slice(2, 8)}`
  const durationMs = Number(get('--wait-ms') ?? '90000')
  const agentName = get('--agent-name') ?? 'voice-agent'
  if (!userId) {
    console.error('Usage: harness.mts --user-id <auth_user_id> [--prompt "..."] [--identity ...] [--wait-ms 90000]')
    process.exit(2)
  }
  return { userId, prompt, identity, durationMs, agentName }
}

async function mintAccessToken(room: string, identity: string): Promise<string> {
  const apiKey = process.env['LIVEKIT_API_KEY']
  const apiSecret = process.env['LIVEKIT_API_SECRET']
  if (!apiKey || !apiSecret) throw new Error('LIVEKIT_API_KEY / LIVEKIT_API_SECRET not set')
  const at = new AccessToken(apiKey, apiSecret, { identity })
  at.addGrant({ room, roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: true })
  return at.toJwt()
}

function httpUrl(wsUrl: string): string {
  return wsUrl.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:')
}

async function main() {
  const { userId, prompt, identity, durationMs, agentName } = parseArgs()
  const url = process.env['LIVEKIT_URL']
  const apiKey = process.env['LIVEKIT_API_KEY']
  const apiSecret = process.env['LIVEKIT_API_SECRET']
  const voiceToolJwtSecret = process.env['VOICE_TOOL_JWT_SECRET']
  if (!url || !apiKey || !apiSecret) throw new Error('LIVEKIT_URL/API_KEY/API_SECRET not set')
  if (!voiceToolJwtSecret) throw new Error('VOICE_TOOL_JWT_SECRET not set')

  const chatId = randomUUID()
  const roomName = `room-${chatId}`

  const voiceToolJwt = await mintVoiceToolJwt(userId, roomName, voiceToolJwtSecret)
  console.log(`[harness] minted voiceToolJwt for user=${userId}`)

  const apiBase = httpUrl(url)
  const rooms = new RoomServiceClient(apiBase, apiKey, apiSecret)
  await rooms.createRoom({
    name: roomName,
    metadata: JSON.stringify({ voiceToolJwt }),
    emptyTimeout: 300,
  })
  console.log(`[harness] created room ${roomName} with metadata`)

  const dispatch = new AgentDispatchClient(apiBase, apiKey, apiSecret)
  // Pass voiceToolJwt via dispatch metadata too — some agent runtimes read
  // metadata from the dispatch (job context) rather than the room.
  const dispatchRes = await dispatch.createDispatch(roomName, agentName, {
    metadata: JSON.stringify({ voiceToolJwt }),
  })
  console.log(`[harness] dispatched agent ${agentName}: ${dispatchRes.id}`)

  // Sanity-check the room actually carries the metadata we set.
  const list = await rooms.listRooms([roomName])
  const found = list[0]
  console.log(`[harness] room metadata length=${found?.metadata?.length ?? 0}`)

  const token = await mintAccessToken(roomName, identity)
  const room = new Room()

  const onText = (topic: string) =>
    room.registerTextStreamHandler(topic, async (reader, info) => {
      const id = info?.identity ?? '?'
      let buf = ''
      for await (const chunk of reader) buf += chunk
      console.log(`[text-stream:${topic}] from=${id} ${JSON.stringify(buf)}`)
    })
  onText('lk.chat')
  onText('lk.transcription')

  room.on(RoomEvent.DataReceived, (payload: Uint8Array, _participant, _kind, topic?: string) => {
    const text = new TextDecoder().decode(payload)
    console.log(`[data] topic=${topic ?? '<none>'} text=${text.slice(0, 600)}`)
  })

  room.on(RoomEvent.ParticipantConnected, (p) => console.log(`[+] participant ${p.identity}`))
  room.on(RoomEvent.ParticipantDisconnected, (p) => console.log(`[-] participant ${p.identity}`))
  room.on(RoomEvent.Disconnected, (reason) => console.log(`[!] disconnected: ${reason}`))

  console.log(`[harness] connecting as ${identity} to ${roomName}`)
  await room.connect(url, token, { autoSubscribe: true, dynacast: false })
  console.log(`[harness] connected. local sid=${room.localParticipant?.sid}`)

  // The agent's textInputCallback is only registered after session.start()
  // completes — that takes ~5-8s after join. Waiting before injection.
  await new Promise((r) => setTimeout(r, 8000))

  console.log(`[harness] sending text: ${JSON.stringify(prompt)}`)
  await room.localParticipant!.sendText(prompt, { topic: 'lk.chat' })

  console.log(`[harness] listening for ${durationMs}ms…`)
  await new Promise((r) => setTimeout(r, durationMs))

  await room.disconnect()
  console.log('[harness] done')
  process.exit(0)
}

main().catch((err) => {
  console.error('[harness] fatal:', err)
  process.exit(1)
})
