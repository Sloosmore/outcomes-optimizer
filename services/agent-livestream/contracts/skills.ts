import { z } from 'zod'

export const SkillErrorResponse = z.object({
  error: z.string(),
})

export type SkillErrorResponse = z.infer<typeof SkillErrorResponse>
