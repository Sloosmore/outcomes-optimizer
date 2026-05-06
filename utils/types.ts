/**
 * Shared constants and types for utils modules
 */

// Directory and file names
export const SKILLS_DIR = 'skills' as const
export const CONFIG_FILE = 'config.yaml' as const
export const SKILL_MARKER_FILE = 'SKILL.md' as const

// Single source of truth for Claude model IDs. Any non-TS reference (YAML, shell)
// that hardcodes one of these strings must point back here in a comment.
export const CLAUDE_MODEL = 'claude-sonnet-4-6' as const
export const CLAUDE_FALLBACK_MODEL = 'claude-opus-4-7' as const

// OpenSkill spec validation limits
export const MAX_NAME_LENGTH = 64
export const MAX_DESCRIPTION_LENGTH = 1024
export const MAX_COMPATIBILITY_LENGTH = 500

// Other validation limits
export const MAX_PROMPT_LENGTH = 100000
export const MAX_PATH_LENGTH = 256

// Safe branch name pattern — same as used in commitEpoch and openPRAdapter
export const SAFE_BRANCH_RE = /^[a-zA-Z0-9][a-zA-Z0-9_./-]*$/

// Git command timeout (30 seconds)
export const GIT_COMMAND_TIMEOUT_MS = 30000

// Max loop duration (24 hours) - self-hosted runners have no 6h limit
export const MAX_LOOP_DURATION_MS = 24 * 60 * 60 * 1000 // 86,400,000 ms

// Directories to check for orphaned files
export const ORPHAN_CHECK_DIRS = ['scripts', 'references', 'assets'] as const
