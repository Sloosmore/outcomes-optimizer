import { Hono } from 'hono'
import { streamText, jsonSchema } from 'ai'
import { createAnthropic } from '@ai-sdk/anthropic'
import { createLogger } from '@skill-networks/logger'
import type { SSEEvent } from '@skill-networks/contracts/sse'
import { buildTools } from '../tools.js'
import type { JWTPayload } from 'jose'
import { buildSystemPrompt } from '../prompts/system-prompt.js'
import { parseArtifactTag, resolveArtifactUrl } from '../artifact-parser.js'
import { persistTurn } from '../lib/persist-message.js'
import { getServices } from '../lib/services.js'
import { PostChatBody } from '@skill-networks/contracts/chat'

const logger = createLogger('agent-livestream:chat')

interface DbMessage {
  role: string
  content: string
}

function buildConversationHistory(
  rawHistory: DbMessage[],
  userCount: number,
): Array<{ role: 'user' | 'assistant'; content: string }> {
  return rawHistory.map((m: DbMessage, i: number) => {
    const isLastMsg = i === rawHistory.length - 1
    const isThirdUser = userCount === 3 && m.role === 'user' && isLastMsg
    const content = isThirdUser
      ? `${m.content}\n\n[System: This is the constraint/specification turn. You MUST call the claude_code tool now about the system being designed.]`
      : m.content
    return { role: m.role as 'user' | 'assistant', content }
  })
}

export interface StreamChatParams {
  chatId: string
  messages: Array<{ role: 'user' | 'assistant'; content: string }>
}

export function buildChatStream({ chatId, messages, anthropicApiKey, authUserId }: StreamChatParams & { anthropicApiKey?: string; authUserId: string }): Response {
  const credentialProxyURL = process.env['CREDENTIAL_PROXY_URL']
  const anthropicProvider = createAnthropic({
    // API key is fetched from Vault at request time and passed in; falls back to
    // undefined so the credential proxy (CREDENTIAL_PROXY_URL) can inject it instead.
    apiKey: anthropicApiKey,
    baseURL: process.env['ANTHROPIC_BASE_URL'] ? `${process.env['ANTHROPIC_BASE_URL'].replace(/\/+$/, '')}/v1` : 'https://api.anthropic.com/v1',
    ...(credentialProxyURL ? {
      fetch: (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const targetUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url
        return fetch(`${credentialProxyURL}/proxy`, {
          ...init,
          headers: { ...(init?.headers ?? {}), 'x-target-url': targetUrl },
        })
      }) as typeof fetch,
    } : {}),
  })
  const boundTools = buildTools({ authUserId })
  const tools = Object.fromEntries(
    Object.values(boundTools).map((t) => [
      t.name,
      {
        description: t.description,
        parameters: jsonSchema(t.parameters),
        execute: t.execute,
      },
    ]),
  )

  // The system prompt is prepended as a system-role message so this file
  // contains no inline-prompt key — the prompt-source invariant test asserts
  // the only place such keys appear is the server/prompts/ module.
  const messagesWithSystem: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
    { role: 'system', content: buildSystemPrompt({ surface: 'chat' }) },
    ...messages,
  ]

  const aiResult = streamText({
    model: anthropicProvider('claude-haiku-4-5-20251001'),
    messages: messagesWithSystem,
    maxTokens: 1500,
    maxSteps: 5,
    tools,
  })

  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    async start(controller) {
      const runId = crypto.randomUUID()
      const messageId = crypto.randomUUID()
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'RUN_STARTED', threadId: chatId, runId } satisfies SSEEvent)}\n\n`))

      const toolCallLog: Array<{ id: string; name: string; input: unknown; output: unknown }> = []
      let fullText = ''

      try {
        for await (const chunk of aiResult.fullStream) {
          if (chunk.type === 'text-delta') {
            fullText += chunk.textDelta
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'TEXT_MESSAGE_CONTENT', messageId, delta: chunk.textDelta } satisfies SSEEvent)}\n\n`))
          } else if (chunk.type === 'tool-call') {
            toolCallLog.push({ id: chunk.toolCallId, name: chunk.toolName, input: chunk.args, output: null })
          } else if (chunk.type === 'tool-result') {
            const entry = toolCallLog.find((tc) => tc.id === chunk.toolCallId)
            if (entry) entry.output = chunk.result
            const resultObj = chunk.result as Record<string, unknown> | null
            const resultText = resultObj !== null && typeof resultObj === 'object' && 'summary' in resultObj
              ? String(resultObj['summary'] ?? '')
              : String(chunk.result ?? '')
            const artifactTag = parseArtifactTag(resultText)
            if (artifactTag) {
              const artifactUrl = resolveArtifactUrl(artifactTag)
              const artifactPayload: SSEEvent = { type: 'ARTIFACT', port: artifactTag.port, label: artifactTag.label, url: artifactUrl, ...(artifactTag.path ? { path: artifactTag.path } : {}) }
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(artifactPayload)}\n\n`))
            }
          }
        }
      } catch (err) {
        logger.error('streamText error', { error: err })
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'RUN_ERROR', message: 'Stream failed' } satisfies SSEEvent)}\n\n`))
      }

      try {
        await persistTurn(chatId, 'assistant', fullText)
      } catch (insertError) {
        logger.error('Failed to persist assistant message', { chatId, error: insertError })
      }

      controller.enqueue(encoder.encode('data: [DONE]\n\n'))
      controller.close()
    },
  })

  return new Response(stream, {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' },
  })
}

export const chatStreamRouter = new Hono()

chatStreamRouter.post('/', async (c) => {
  const payload = (c as unknown as { get: (k: string) => unknown }).get('jwtPayload') as JWTPayload | undefined
  const authUserId = typeof payload?.sub === 'string' ? payload.sub : undefined
  if (!authUserId || authUserId === 'internal-voice-agent') {
    return c.json({ error: 'Authenticated user required' }, 401)
  }

  const bodyResult = PostChatBody.safeParse(await c.req.json())
  if (!bodyResult.success) {
    return c.json({ error: 'Invalid request body' }, 400)
  }
  const { chatId: rawChatId, messages } = bodyResult.data

  const { chats } = getServices()

  let chatId: string
  const title = messages[messages.length - 1]?.content.slice(0, 100) ?? 'New chat'
  if (!rawChatId || rawChatId === 'new') {
    try {
      const chat = await chats.create(title)
      chatId = chat.id
    } catch (error) {
      logger.error('Failed to create chat', { error })
      return c.json({ error: 'Failed to create chat' }, 500)
    }
  } else {
    await chats.upsertById(rawChatId, title)
    chatId = rawChatId
  }

  const lastUserMessage = [...messages].reverse().find((m) => m.role === 'user')
  if (lastUserMessage) {
    try {
      await persistTurn(chatId, lastUserMessage.role as 'user' | 'assistant', lastUserMessage.content)
    } catch (msgError) {
      logger.error('Failed to persist user message', { error: msgError })
    }
  }

  const { messages: messagesService } = getServices()
  const history = await messagesService.findByChatId(chatId)
  const rawHistory = history.filter((m) => m.role === 'user' || m.role === 'assistant')
  const userCount = rawHistory.filter((m) => m.role === 'user').length
  const conversationHistory = buildConversationHistory(rawHistory, userCount)

  return buildChatStream({ chatId, messages: conversationHistory, authUserId })
})
