import { describe, it, expect } from 'vitest'
import { mapStateSnapshot } from '../state-snapshot-mapper'

describe('mapStateSnapshot', () => {
  it('returns safe default for null input', () => {
    expect(mapStateSnapshot(null)).toEqual({
      goal: '',
      currentStory: null,
      progress: 0,
      stories: [],
    })
  })

  it('returns safe default for undefined input', () => {
    expect(mapStateSnapshot(undefined)).toEqual({
      goal: '',
      currentStory: null,
      progress: 0,
      stories: [],
    })
  })

  it('maps a valid state_snapshot to ProcessStateViewModel', () => {
    const snapshot = {
      epoch: 4,
      goal: 'Process Epoch Observability',
      active_prd: 'prd-003',
      current_story: 4,
      prds: {
        'prd-003': {
          status: 'active',
          stories_passed: [1, 2, 3],
        },
      },
    }

    const result = mapStateSnapshot(snapshot)

    expect(result.goal).toBe('Process Epoch Observability')
    expect(result.currentStory).toBe(4)
    expect(result.stories).toHaveLength(4)
  })

  it('classifies stories as completed, in_progress, and pending', () => {
    const snapshot = {
      goal: 'Test Goal',
      active_prd: 'prd-001',
      current_story: 4,
      prds: {
        'prd-001': {
          stories_passed: [1, 2, 3],
        },
      },
    }

    const result = mapStateSnapshot(snapshot)

    expect(result.stories[0]).toEqual({ id: 1, label: 'Story 1', status: 'completed' })
    expect(result.stories[1]).toEqual({ id: 2, label: 'Story 2', status: 'completed' })
    expect(result.stories[2]).toEqual({ id: 3, label: 'Story 3', status: 'completed' })
    expect(result.stories[3]).toEqual({ id: 4, label: 'Story 4', status: 'in_progress' })
  })

  it('computes progress as fraction of stories_passed over total', () => {
    const snapshot = {
      goal: 'Test',
      active_prd: 'prd-001',
      current_story: 4,
      prds: {
        'prd-001': {
          stories_passed: [1, 2, 3],
        },
      },
    }

    const result = mapStateSnapshot(snapshot)
    // 3 passed / 8 total (UNKNOWN_TOTAL_STORIES) = 0.375
    expect(result.progress).toBeCloseTo(3 / 8)
  })

  it('handles missing active_prd gracefully', () => {
    const snapshot = {
      goal: 'No PRD',
      current_story: 2,
    }

    const result = mapStateSnapshot(snapshot)
    expect(result.goal).toBe('No PRD')
    expect(result.currentStory).toBe(2)
    expect(result.stories).toHaveLength(2)
    // No stories_passed, so story 2 is in_progress, story 1 is pending
    expect(result.stories[0].status).toBe('pending')
    expect(result.stories[1].status).toBe('in_progress')
  })

  it('handles missing goal gracefully', () => {
    const result = mapStateSnapshot({ current_story: 1 })
    expect(result.goal).toBe('')
  })

  it('handles non-object input gracefully', () => {
    expect(mapStateSnapshot(42)).toEqual({ goal: '', currentStory: null, progress: 0, stories: [] })
    expect(mapStateSnapshot('string')).toEqual({ goal: '', currentStory: null, progress: 0, stories: [] })
  })
})
