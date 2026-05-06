import { resolve, join, dirname } from 'path'
import { homedir } from 'os'
import { mkdirSync, existsSync, readdirSync, copyFileSync } from 'fs'
import type { CLITarget, CLIOutput, CLIFactoryOptions, PreflightHook, PostflightHook } from '../../types.js'
import { codexPreflightHooks } from './preflight.js'

// Note: gpt-5.3-codex API access not yet available (Feb 2026)
const MODEL = 'gpt-5.2-codex'

/**
 * Postflight hook that saves Codex session traces to workspace
 * Codex stores session logs at ~/.codex/sessions/YYYY/MM/DD/*.jsonl
 */
const saveCodexTraces: PostflightHook = {
  name: 'save-codex-traces',
  async run(context) {
    const { workingDir, sessionId } = context
    const codexSessionsDir = resolve(homedir(), '.codex', 'sessions')
    const destDir = resolve(workingDir, 'workspace', '.codex-logs')

    if (!existsSync(codexSessionsDir)) {
      console.log('No Codex sessions directory found, skipping trace collection')
      return
    }

    mkdirSync(destDir, { recursive: true })

    // Get today's date path (YYYY/MM/DD)
    const now = new Date()
    const year = now.getFullYear().toString()
    const month = (now.getMonth() + 1).toString().padStart(2, '0')
    const day = now.getDate().toString().padStart(2, '0')
    const todayPath = join(codexSessionsDir, year, month, day)

    if (!existsSync(todayPath)) {
      console.log(`No sessions for today at ${todayPath}`)
      return
    }

    // Try to find specific session file first (sessionId is thread_id from Codex)
    const files = readdirSync(todayPath).filter(f => f.endsWith('.jsonl'))
    let filesToCopy = files

    // If we have a valid thread_id, try to find just that session
    if (sessionId && !sessionId.startsWith('codex-')) {
      const matchingFiles = files.filter(f => f.includes(sessionId))
      if (matchingFiles.length > 0) {
        filesToCopy = matchingFiles
      }
    }

    let copied = 0
    for (const file of filesToCopy) {
      const src = join(todayPath, file)
      const dest = join(destDir, file)
      try {
        copyFileSync(src, dest)
        copied++
      } catch (err) {
        console.error(`Failed to copy session file ${file}:`, err)
      }
    }

    console.log(`Copied ${copied} Codex session log(s) to ${destDir}`)
  }
}

export function createCodexTarget(options: CLIFactoryOptions): CLITarget {
  const isHomedir = options.baseDir === homedir()
  const preflight = [...codexPreflightHooks]
  const postflight: PostflightHook[] = [saveCodexTraces]
  const configDir = resolve(options.baseDir, '.codex')

  // Codex looks for skills in .agents/skills
  const agentsSkillsDir = resolve(options.baseDir, '.agents', 'skills')

  return {
    name: 'codex',
    configDir,
    skillsDir: agentsSkillsDir,
    workingDir: isHomedir ? process.cwd() : options.baseDir,
    envVar: 'OPENAI_API_KEY',

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
      return [
        'codex',
        'exec', prompt,
        '--model', MODEL,
        '--dangerously-bypass-approvals-and-sandbox',
        '--json'
      ]
    },

    parseOutput(stdout: string): CLIOutput {
      if (!stdout.trim()) {
        return {
          sessionId: `codex-${Date.now()}`,
          success: false,
          error: 'No output received',
          rawOutput: stdout
        }
      }

      // Codex outputs JSONL (newline-delimited JSON events)
      const lines = stdout.trim().split('\n')
      let sessionId = `codex-${Date.now()}`
      let success = false
      let error: string | undefined
      let parsedAnyLine = false

      for (const line of lines) {
        try {
          const event = JSON.parse(line)
          parsedAnyLine = true

          // Extract thread_id from thread.started event
          if (event.type === 'thread.started' && event.thread_id) {
            sessionId = event.thread_id
          }

          // turn.completed indicates success
          if (event.type === 'turn.completed') {
            success = true
          }

          // turn.failed indicates failure
          if (event.type === 'turn.failed') {
            success = false
            error = event.error?.message || 'Turn failed'
          }

          // Capture any error events
          if (event.type === 'error') {
            error = event.message
          }
        } catch {
          // Skip non-JSON lines (Codex may output progress text)
        }
      }

      // If no valid JSON was found, indicate a parse error
      if (!parsedAnyLine) {
        error = 'Failed to parse output: no valid JSON found'
      }

      return {
        sessionId,
        success,
        error,
        rawOutput: stdout
      }
    },

    validateEnvironment(): void {
      if (!process.env.OPENAI_API_KEY) {
        throw new Error(
          'Missing OpenAI credentials. Please set OPENAI_API_KEY environment variable.'
        )
      }
    }
  }
}
