/**
 * Tool tier classification for agent event sources.
 *
 * ToolTier — pure data, no runtime logic.
 *
 * Consumer pattern:
 *   const tier = CLAUDE_CODE_TOOL_TIER_MAP[source] ?? ToolTier.generic
 */

export const ToolTier = {
  subagent: 'subagent',
  message: 'message',
  generic: 'generic',
} as const

export type ToolTier = typeof ToolTier[keyof typeof ToolTier]

/**
 * Maps known event sources to their ToolTier.
 * Unrecognized sources fall back to ToolTier.generic via the nullish coalescing
 * operator on the consumer side: `CLAUDE_CODE_TOOL_TIER_MAP[source] ?? ToolTier.generic`
 */
export const CLAUDE_CODE_TOOL_TIER_MAP: Record<string, ToolTier> = {
  // Subagent sources
  Agent: ToolTier.subagent,
  Skill: ToolTier.subagent,

  // Message sources
  assistant: ToolTier.message,

  // Token events
  token_usage: ToolTier.generic,

  // Generic tool sources
  Bash: ToolTier.generic,
  Read: ToolTier.generic,
  Write: ToolTier.generic,
  Edit: ToolTier.generic,
  Glob: ToolTier.generic,
  Grep: ToolTier.generic,
  TodoWrite: ToolTier.generic,
  TaskOutput: ToolTier.generic,
}
