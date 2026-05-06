// Agent runtime imports — @livekit/agents pulls in @livekit/rtc-node (native binary).
// These MUST NOT go through livekit-adapter.ts which is in the Vercel BFF chain.
import { cli, defineAgent, voice, llm, WorkerOptions, inference, VAD } from './adapters/realtime/livekit-agents.js'
import type { JobContext, JobProcess } from './adapters/realtime/livekit-agents.js'
import { BackgroundVoiceCancellation } from './adapters/realtime/noise-cancellation.js'
import { fileURLToPath } from 'node:url'
import { LocalLLM } from './local-llm.js'
import { VOICE_AGENT } from './constants.js'
import { createLogger } from '@skill-networks/logger'
import { createVoiceTools } from './tools/voice-tools.js'
import { buildSystemPrompt } from './prompts/system-prompt.js'
import { persistTurn } from './lib/persist-message.js'
import { remoteLog } from './lib/remote-log.js'

const logger = createLogger('agent-livestream:voice-agent')

remoteLog('worker.module.loaded', { node: process.version, platform: process.platform, arch: process.arch })

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export default defineAgent({
  // Pre-warm VAD model so it's ready before the first job arrives
  prewarm: async (proc: JobProcess) => {
    remoteLog('worker.prewarm.start')
    proc.userData.vad = await VAD.load({
      activationThreshold: VOICE_AGENT.VAD_ACTIVATION_THRESHOLD,
      minSpeechDuration: VOICE_AGENT.VAD_MIN_SPEECH_MS,
      minSilenceDuration: VOICE_AGENT.VAD_MIN_SILENCE_MS,
    })
    logger.info('VAD model loaded')
    remoteLog('worker.prewarm.done')
  },

  entry: async (ctx: JobContext) => {
    remoteLog('worker.entry.start', { roomName: ctx.room.name })
    await ctx.connect()
    remoteLog('worker.entry.connected', { roomName: ctx.room.name })

    // Extract chatId from room name (room-{chatId})
    const roomName = ctx.room.name ?? ''
    const chatId = roomName.replace('room-', '')
    if (!UUID_RE.test(chatId)) {
      logger.error('invalid chatId derived from room name', { roomName })
      return
    }

    // BFF_URL: Vercel BFF URL in production (set via BFF_URL secret in LiveKit Cloud).
    // Defaults to localhost:3001 for local development (BFF started separately via node.ts).
    const BFF_URL = (process.env['BFF_URL'] ?? 'http://localhost:3001').replace(/\/$/, '')

    // Fetch last N messages for context prefix.
    // Uses X-Research-Secret to bypass the JWT wall (voice agent has no Supabase token).
    const messagesUrl = `${BFF_URL}/api/chats/${chatId}/messages`
    let history: Array<{ role: string; content: string }> = []
    try {
      const internalSecret = process.env['RESEARCH_INTERNAL_SECRET']
      const headers: Record<string, string> = {}
      if (internalSecret) headers['X-Research-Secret'] = internalSecret
      const res = await fetch(messagesUrl, { headers })
      if (res.ok) {
        const all = await res.json() as Array<{ role: string; content: string }>
        history = all.slice(-VOICE_AGENT.HISTORY_LIMIT)
      } else if (res.status === 401) {
        logger.warn('History fetch returned 401 — RESEARCH_INTERNAL_SECRET may not be set', { chatId })
      }
    } catch {
      // BFF may not be running; continue without history
    }

    // Read voiceToolJwt from room metadata (set by token.ts when minting,
    // or by the LiveKit-direct test harness for headless verification).
    let voiceToolJwt: string | undefined
    try {
      const meta = ctx.room.metadata
      if (meta) {
        const parsed = JSON.parse(meta) as { voiceToolJwt?: string }
        voiceToolJwt = parsed.voiceToolJwt
      }
    } catch { /* best effort */ }

    // Build chat context from DB history
    const prefixCtx = llm.ChatContext.empty()
    for (const msg of history) {
      const role = msg.role === 'user' ? 'user' as const : 'assistant' as const
      prefixCtx.addMessage({ role, content: msg.content })
    }

    // STT + TTS via LiveKit Inference. LiveKit Cloud holds the Deepgram and
    // Cartesia credentials and bills via the same LiveKit account — no extra
    // env vars beyond LIVEKIT_API_KEY/LIVEKIT_API_SECRET. Models are configured
    // by name (provider/model) in VOICE_AGENT.STT_MODEL / TTS_MODEL.
    const stt = new inference.STT({
      model: VOICE_AGENT.STT_MODEL,
      language: 'en',
    })
    const tts = new inference.TTS({
      model: VOICE_AGENT.TTS_MODEL,
      voice: VOICE_AGENT.TTS_VOICE,
    })

    const vad = ctx.proc.userData.vad as VAD

    const session = new voice.AgentSession({
      vad,
      stt,
      llm: new LocalLLM(VOICE_AGENT.LLM_MODEL),
      tts,
      turnHandling: {
        interruption: {
          resumeFalseInterruption: true,
        },
      },
      // Default is 10s — too short for our local proxy which can take 10-15s per inference.
      // Tool calls need two inferences (generate call + generate response), so 60s minimum.
      connOptions: { llmConnOptions: { timeoutMs: 60_000, maxRetry: 0 } },
      // Default is 3 — too low for prompts that ask for two artifacts in one
      // turn (each artifact is its own claude_code call + reply round-trip).
      // 6 leaves room for two full claude_code cycles plus a final summary turn.
      maxToolSteps: 6,
    })

    // Persist messages on each turn and notify frontend via LiveKit data channel
    session.on(voice.AgentSessionEventTypes.ConversationItemAdded, (event) => {
      const item = event.item
      const role = item.role === 'user' ? 'user' : 'assistant'
      const text = item.textContent
      if (!text) return
      if (role === 'user') {
        logger.info('phase', {
          phase: 'user_turn_received',
          chatId,
          t_ms: performance.now(),
          source: 'voice_or_text',
          textPreview: text.slice(0, 120),
        })
      }

      // Send to frontend via LiveKit data channel. Persistence is best-effort —
      // when it fails (e.g. FK violation because no chats row exists yet) we still
      // emit an ephemeral message_added so the user sees the bubble. Without this
      // fallback the persist failure would silently swallow the turn and the chat
      // surface would look frozen.
      const emit = (msg: { id: string; chatId: string; role: string; content: string; createdAt: string; ephemeral?: boolean }): void => {
        if (!ctx.agent) return
        void ctx.agent.sendText(JSON.stringify(msg), { topic: 'message_added' })
      }

      void persistTurn(chatId, role, text).then((msg) => {
        emit({
          id: msg.id,
          chatId: msg.chat_id,
          role: msg.role,
          content: msg.content,
          createdAt: msg.created_at,
        })
      }).catch((err: unknown) => {
        logger.error('persistTurn failed — emitting ephemeral message', {
          chatId,
          role,
          error: err instanceof Error ? err.message : String(err),
        })
        // MessageAdded schema requires id to be a UUID — use randomUUID rather
        // than a string prefix so the frontend's safeParse accepts the payload.
        emit({
          id: crypto.randomUUID(),
          chatId,
          role,
          content: text,
          createdAt: new Date().toISOString(),
          ephemeral: true,
        })
      })
    })

    const internalSecret = process.env['RESEARCH_INTERNAL_SECRET']
    const { claudeCodeTool, shareScreenTool, dispatchTool } = createVoiceTools({
      session,
      ctx,
      chatId,
      voiceToolJwt,
      bffUrl: BFF_URL,
      internalSecret,
    })

    await session.start({
      agent: new voice.Agent({
        instructions: buildSystemPrompt({ surface: 'voice' }),
        chatCtx: prefixCtx,
        tools: { claude_code: claudeCodeTool, share_screen: shareScreenTool, dispatch: dispatchTool },
      }),
      room: ctx.room,
      inputOptions: {
        noiseCancellation: BackgroundVoiceCancellation(),
        // Text turns share the same chatCtx as voice turns so the agent has a single
        // unified conversation memory. Earlier this was overridden with
        // `ChatContext.empty()` to dodge pollution from a looping audio test fixture, but
        // that broke multi-turn text conversations (each text message arrived amnesiac).
        // The right place to keep test fixtures from polluting prod chatCtx is the test
        // harness itself, not by gutting the production text path.
        //
        // allowInterruptions:false — prevents audio VAD from interrupting text-turn speech
        //   before tool outputs are committed, avoiding permanent orphaned tool items.
        // force:true — interrupts even non-interruptible speeches so injected text is
        //   never dropped by the room_io error handler.
        textInputCallback: (sess, ev) => {
          logger.info('phase', {
            phase: 'user_turn_received',
            chatId,
            t_ms: performance.now(),
            source: 'textInputCallback',
            textPreview: ev.text.slice(0, 120),
          })
          sess.interrupt({ force: true })
          ;(sess.generateReply as (opts: Record<string, unknown>) => void)({
            userInput: ev.text,
            allowInterruptions: false,
          })
        },
      },
    })
  },
})

// Named-dispatch worker. The BFF (`token.ts`) calls
// `AgentDispatchClient.createDispatch(roomName, 'voice-agent', metadata)`
// to bind a worker to each new room — community-confirmed reliable path
// vs auto-dispatch + `createRoom({agents:[…]})`, both of which are open
// bugs (livekit/agents-js#290, livekit/agents-js#1211). `livekit.toml`'s
// `auto_dispatch` is a no-op at runtime — the SDK doesn't read the toml.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  remoteLog('worker.boot.cli-runApp', { agentName: 'voice-agent' })
  cli.runApp(new WorkerOptions({ agent: import.meta.filename, agentName: 'voice-agent' }))
}
