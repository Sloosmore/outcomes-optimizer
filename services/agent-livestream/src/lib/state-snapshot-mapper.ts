import type { ProcessStateViewModel, StoryItem, StoryStatus } from '@skill-networks/contracts/process-state'
import { UNKNOWN_TOTAL_STORIES } from '../constants'

function safeNumber(value: unknown): number | null {
  if (typeof value === 'number' && !isNaN(value)) return value
  return null
}

function safeString(value: unknown): string {
  if (typeof value === 'string') return value
  return ''
}

function safeArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  return []
}

function safeObject(value: unknown): Record<string, unknown> | null {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return null
}

function getStoriesPassed(state: Record<string, unknown>): number[] {
  const activePrd = safeString(state['active_prd'])
  if (!activePrd) return []

  const prds = safeObject(state['prds'])
  if (!prds) return []

  const prdEntry = safeObject(prds[activePrd])
  if (!prdEntry) return []

  const storiesPassed = safeArray(prdEntry['stories_passed'])
  return storiesPassed.filter((v): v is number => typeof v === 'number')
}

function deriveStories(currentStory: number | null, storiesPassed: number[]): StoryItem[] {
  if (currentStory === null || currentStory < 1) return []

  const stories: StoryItem[] = []
  const passedSet = new Set(storiesPassed)

  for (let i = 1; i <= currentStory; i++) {
    let status: StoryStatus
    if (passedSet.has(i)) {
      status = 'completed'
    } else if (i === currentStory) {
      status = 'in_progress'
    } else {
      status = 'pending'
    }
    stories.push({ id: i, label: `Story ${i}`, status })
  }

  return stories
}

function deriveProgress(storiesPassed: number[], currentStory: number | null): number {
  const total = currentStory !== null && currentStory > 0
    ? Math.max(currentStory, UNKNOWN_TOTAL_STORIES)
    : UNKNOWN_TOTAL_STORIES
  if (total === 0) return 0
  return Math.min(1, storiesPassed.length / total)
}

export function mapStateSnapshot(snapshot: unknown): ProcessStateViewModel {
  if (!snapshot || typeof snapshot !== 'object') {
    return { goal: '', currentStory: null, progress: 0, stories: [] }
  }

  const state = snapshot as Record<string, unknown>

  const goal = safeString(state['goal'])
  const currentStory = safeNumber(state['current_story'])
  const storiesPassed = getStoriesPassed(state)
  const stories = deriveStories(currentStory, storiesPassed)
  const progress = deriveProgress(storiesPassed, currentStory)

  return { goal, currentStory, progress, stories }
}

