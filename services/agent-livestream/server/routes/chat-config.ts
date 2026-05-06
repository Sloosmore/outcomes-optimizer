import { Hono } from 'hono'
import { getAllToolDefs } from '../tools.js'
import { buildSystemPrompt } from '../prompts/system-prompt.js'
import type { ApiChatConfigResponse } from '@skill-networks/contracts/chat'

export const chatConfigRouter = new Hono()

chatConfigRouter.get('/', (c) => {
  return c.json({
    tools: getAllToolDefs().map(({ name, description, parameters }) => ({ name, description, parameters })),
    systemPrompt: buildSystemPrompt({ surface: 'chat' }),
  } satisfies ApiChatConfigResponse)
})
