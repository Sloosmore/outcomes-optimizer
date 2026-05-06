import { z } from 'zod'

export const ApiOrgResponse = z.object({
  projects: z.array(z.object({
    id: z.string().uuid(),
    name: z.string(),
    initials: z.string().optional(),
  })),
})

export type ApiOrgResponse = z.infer<typeof ApiOrgResponse>
