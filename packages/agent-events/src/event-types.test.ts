import { describe, it, expect } from 'vitest'
import { EventType } from './event-types.js'

describe('EventType backward compatibility', () => {
  it('SDK event values match stored DB strings', () => {
    expect(EventType.ASSISTANT).toBe('assistant')
    expect(EventType.TOOL_USE).toBe('tool_use')
    expect(EventType.TOOL_RESULT).toBe('tool_result')
    expect(EventType.RESULT_SUCCESS).toBe('result:success')
    expect(EventType.RESULT_ERROR).toBe('result:error')
  })

  it('lifecycle event values match expected strings', () => {
    expect(EventType.PROCESS_START).toBe('process:start')
    expect(EventType.PROCESS_END).toBe('process:end')
    expect(EventType.PROCESS_SLEEP).toBe('process:sleep')
    expect(EventType.PROCESS_STALE).toBe('process:stale')
    expect(EventType.EPOCH_END).toBe('epoch:end')
    expect(EventType.WORKTREE_PROVISIONED).toBe('worktree:provisioned')
  })

  it('PROCESS_BLOCKED value matches expected string', () => {
    expect(EventType.PROCESS_BLOCKED).toBe('process:blocked')
  })
})
