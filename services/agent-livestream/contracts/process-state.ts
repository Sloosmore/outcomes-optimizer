import { z } from 'zod'

// ProcessStateViewModel — clean UI type derived from state_snapshot
// Mirrors state.json structure: active_prd tells you which PRD is active,
// PRD stories array gives the story list
const StoryStatusSchema = z.enum(['pending', 'in_progress', 'completed'])

export const StoryItemSchema = z.object({
  id: z.number(),
  label: z.string(),
  status: StoryStatusSchema,
})

export const ProcessStateViewModelSchema = z.object({
  goal: z.string(),
  currentStory: z.number().nullable(),
  progress: z.number().min(0).max(1),  // 0-1 fraction
  stories: z.array(StoryItemSchema),
})

export type ProcessStateViewModel = z.infer<typeof ProcessStateViewModelSchema>
export type StoryItem = z.infer<typeof StoryItemSchema>
export type StoryStatus = z.infer<typeof StoryStatusSchema>
