import { ToolTier } from '@contracts/tool-tiers'
import {
  CURSOR_SUBAGENT_SPEED_BOOST,
  CURSOR_SUBAGENT_DURATION_MS,
  CURSOR_GENERIC_SPEED_BOOST,
  CURSOR_GENERIC_DURATION_MS,
  CURSOR_MESSAGE_SPEED_BOOST,
  CURSOR_MESSAGE_DURATION_MS,
} from '@/constants'

export function getImpulseForTier(tier: ToolTier): { speedBoost: number; durationMs: number } {
  switch (tier) {
    case ToolTier.subagent:
      return { speedBoost: CURSOR_SUBAGENT_SPEED_BOOST, durationMs: CURSOR_SUBAGENT_DURATION_MS }
    case ToolTier.message:
      return { speedBoost: CURSOR_MESSAGE_SPEED_BOOST, durationMs: CURSOR_MESSAGE_DURATION_MS }
    case ToolTier.generic:
      return { speedBoost: CURSOR_GENERIC_SPEED_BOOST, durationMs: CURSOR_GENERIC_DURATION_MS }
    default: {
      const _exhaustive: never = tier
      throw new Error(`Unhandled ToolTier: ${String(_exhaustive)}`)
    }
  }
}
