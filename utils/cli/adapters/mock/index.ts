import { resolve } from 'path'
import { homedir } from 'os'
import type { CLITarget, CLIOutput, CLIFactoryOptions, PreflightHook, PostflightHook } from '../../types.js'

export function createMockTarget(options: CLIFactoryOptions): CLITarget {
  const isHomedir = options.baseDir === homedir()
  const preflight: PreflightHook[] = []
  const postflight: PostflightHook[] = []
  const configDir = resolve(options.baseDir, '.mock')

  return {
    name: 'mock',
    configDir,
    skillsDir: resolve(configDir, 'skills'),
    workingDir: isHomedir ? process.cwd() : options.baseDir,
    envVar: '',

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
      const mockOutput = JSON.stringify({
        session_id: `mock-${Date.now()}`,
        success: true,
        prompt
      })
      return ['echo', mockOutput]
    },

    parseOutput(stdout: string): CLIOutput {
      if (!stdout.trim()) {
        return {
          sessionId: `mock-${Date.now()}`,
          success: false,
          error: 'No output received',
          rawOutput: stdout
        }
      }

      try {
        const result = JSON.parse(stdout.trim())
        return {
          sessionId: result.session_id || `mock-${Date.now()}`,
          success: result.success !== false,
          error: result.error,
          rawOutput: stdout
        }
      } catch {
        return {
          sessionId: `mock-${Date.now()}`,
          success: false,
          error: 'Failed to parse JSON output',
          rawOutput: stdout
        }
      }
    },

    validateEnvironment(): void {
      // Mock adapter doesn't require any environment variables
    }
  }
}
