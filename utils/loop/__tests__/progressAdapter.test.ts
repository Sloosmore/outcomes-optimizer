import { describe, it, expect } from 'vitest'

// Mock the run module to prevent side effects when importing utils/loop/index
vi.mock('../../run', () => ({
  run: vi.fn(),
}))

import { parseCheckboxes } from '../index.js'

describe('parseCheckboxes', () => {
  it('counts checked and total correctly', () => {
    const result = parseCheckboxes('- [x] done\n- [ ] pending\n- [x] done')
    expect(result).toEqual({ checked: 2, total: 3 })
  })

  it('returns zeros for no checkboxes', () => {
    const result = parseCheckboxes('# No checkboxes here')
    expect(result).toEqual({ checked: 0, total: 0 })
  })

  it('handles uppercase X', () => {
    const result = parseCheckboxes('- [X] uppercase')
    expect(result).toEqual({ checked: 1, total: 1 })
  })

  it('all pending returns total > 0 with checked = 0', () => {
    const result = parseCheckboxes('- [ ] all pending')
    expect(result).toEqual({ checked: 0, total: 1 })
  })

  it('mixed case - [x] and [X] both count', () => {
    const result = parseCheckboxes('- [x] lower\n- [X] upper\n- [ ] pending')
    expect(result).toEqual({ checked: 2, total: 3 })
  })
})
