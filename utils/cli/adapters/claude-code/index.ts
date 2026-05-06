import { resolve } from 'path'
import { homedir } from 'os'
import type { CLITarget, CLIOutput, CLIFactoryOptions, PreflightHook, PostflightHook } from '../../types.js'
import { ALLOWED_TOOLS } from '../../types.js'
import { CLAUDE_MODEL, CLAUDE_FALLBACK_MODEL } from '../../../types.js'
import { writeSettingsHook } from './preflight.js'
import { traceRecordHook } from './postflight.js'

export function createClaudeCodeTarget(options: CLIFactoryOptions): CLITarget {
  const isHomedir = options.baseDir === homedir()
  const preflight: PreflightHook[] = [writeSettingsHook]
  const postflight: PostflightHook[] = [traceRecordHook]
  const configDir = resolve(options.baseDir, '.claude')

  return {
    name: 'claude-code',
    configDir,
    skillsDir: resolve(configDir, 'skills'),
    workingDir: isHomedir ? process.cwd() : options.baseDir,
    // Primary: ANTHROPIC_API_KEY (local), also supports: CLAUDE_CODE_OAUTH_TOKEN (CI)
    envVar: 'ANTHROPIC_API_KEY',
    fallbackModel: CLAUDE_FALLBACK_MODEL,

    preflight,
    postflight,

    registerPreflight(hook: PreflightHook): void {
      // Prevent duplicate registration
      if (preflight.some(h => h.name === hook.name)) {
        return // Already registered, skip
      }
      preflight.push(hook)
    },

    registerPostflight(hook: PostflightHook): void {
      // Prevent duplicate registration
      if (postflight.some(h => h.name === hook.name)) {
        return // Already registered, skip
      }
      postflight.push(hook)
    },

    buildCommand(prompt: string): string[] {
      // Permissions are handled by the write-claude-settings preflight hook,
      // which writes .claude/settings.json into the working directory before
      // each run. The --settings CLI flag does NOT set permissionMode and
      // cannot unlock file writes — only the project-local settings.json works.
      return [
        'claude',
        '-p', prompt,
        '--model', CLAUDE_MODEL,
        '--output-format', 'stream-json',
        '--verbose',
        '--allowedTools', ALLOWED_TOOLS.join(','),
      ]
    },

    parseOutput(stdout: string): CLIOutput {
      const lines = stdout.trim().split('\n').filter(Boolean)

      if (lines.length === 0) {
        return {
          sessionId: `claude-${Date.now()}`,
          success: false,
          error: 'No output received',
          rawOutput: stdout
        }
      }

      try {
        const events = lines.map(line => JSON.parse(line))
        const resultEvent = events.find(e => e.type === 'result')

        if (!resultEvent) {
          return {
            sessionId: `claude-${Date.now()}`,
            success: false,
            error: 'No result event in output',
            rawOutput: stdout
          }
        }

        const output: CLIOutput = {
          sessionId: resultEvent.session_id || `claude-${Date.now()}`,
          success: resultEvent.is_error !== true,
          result: resultEvent.result,
          cost: resultEvent.total_cost_usd,
          durationMs: resultEvent.duration_ms,
        }

        // Extract usage if present
        if (resultEvent.usage) {
          output.usage = {
            inputTokens: resultEvent.usage.input_tokens || 0,
            outputTokens: resultEvent.usage.output_tokens || 0,
            cacheReadTokens: resultEvent.usage.cache_read_input_tokens,
            cacheCreationTokens: resultEvent.usage.cache_creation_input_tokens,
          }
        }

        // Include error message if present
        if (resultEvent.is_error) {
          output.error = resultEvent.result || 'Unknown error'
        }

        return output
      } catch {
        return {
          sessionId: `claude-${Date.now()}`,
          success: false,
          error: 'Failed to parse JSON output',
          rawOutput: stdout
        }
      }
    },

    validateEnvironment(): void {
      const hasKey = process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_OAUTH_TOKEN
      const isCI = process.env.GITHUB_ACTIONS === 'true' || process.env.CI === 'true'
      if (!hasKey) {
        if (isCI) {
          throw new Error(
            'Missing Anthropic credentials. Please set ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN.\n' +
            'You can also run \'claude /login\' to authenticate.'
          )
        }
        // Local: rely on stored claude credentials from `claude /login`
        console.warn('No ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN set; relying on stored Claude credentials.')
      }
    }
  }
}
