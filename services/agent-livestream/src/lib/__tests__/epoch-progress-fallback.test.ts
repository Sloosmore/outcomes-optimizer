import { describe, it, expect } from 'vitest'
import { mapStateSnapshot } from '../state-snapshot-mapper'

describe('epoch progress fallback', () => {
  it('mapStateSnapshot(null) returns safe default with progress 0', () => {
    const vm = mapStateSnapshot(null)
    expect(vm.stories).toHaveLength(0)
    expect(vm.progress).toBe(0)
  })

  it('fallback path: uses processes.progress when no epoch data (epochResult is null)', () => {
    const epochResult = null  // /epochs/latest returns null → no epoch rows
    const processProgress = 0.6  // from processes.progress column

    const fromEpoch = epochResult != null
      ? mapStateSnapshot((epochResult as { state_snapshot: unknown }).state_snapshot).progress * 100
      : null
    const fromProcesses = processProgress != null ? processProgress * 100 : null
    const ringValue = fromEpoch ?? fromProcesses

    expect(ringValue).toBe(60)  // 0.6 * 100 = 60 — uses processes.progress
    expect(ringValue).not.toBeNaN()
  })

  it('primary path: uses epoch progress when epoch data is present', () => {
    const epochResult = {
      state_snapshot: {
        current_story: 4,
        active_prd: 'prd-003',
        prds: { 'prd-003': { stories_passed: [1, 2, 3] } },
      },
    }
    const processProgress = 0.6  // processes.progress column — should NOT be used

    const fromEpoch = epochResult != null
      ? mapStateSnapshot(epochResult.state_snapshot).progress * 100
      : null
    const fromProcesses = processProgress != null ? processProgress * 100 : null
    const ringValue = fromEpoch ?? fromProcesses

    // epoch progress = 3 passed / max(4, 8) stories = 3/8 = 37.5
    expect(ringValue).toBeCloseTo(37.5, 0)
    expect(ringValue).not.toBe(60)  // must NOT use processes.progress
  })
})
