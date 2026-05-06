import { z } from 'zod'
import { ToolDefSchema } from './chat.js'

export const ApiToolsListResponse = z.object({
  tools: z.array(ToolDefSchema),
})

export type ApiToolsListResponse = z.infer<typeof ApiToolsListResponse>
