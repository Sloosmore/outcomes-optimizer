/**
 * Canonical event type strings used by all emitters.
 * String values are stable — changing them would break historical DB queries.
 */
export const EventType = {
  // Lifecycle
  PROCESS_START: 'process:start',
  PROCESS_END: 'process:end',
  PROCESS_SLEEP: 'process:sleep',
  PROCESS_STALE: 'process:stale',
  PROCESS_BLOCKED: 'process:blocked',
  // Epoch
  EPOCH_END: 'epoch:end',
  // Infrastructure
  WORKTREE_PROVISIONED: 'worktree:provisioned',
  // SDK (existing — values must match what the adapter currently stores)
  ASSISTANT: 'assistant',
  TOOL_USE: 'tool_use',
  TOOL_RESULT: 'tool_result',
  RESULT_SUCCESS: 'result:success',
  RESULT_ERROR: 'result:error',
  TOKEN_USAGE: 'token_usage',
} as const

export type EventType = (typeof EventType)[keyof typeof EventType]
