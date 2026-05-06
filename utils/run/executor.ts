import { spawn } from 'child_process'
import type { CLITarget, CLIOutput } from '../cli/types.js'
import { RATE_LIMIT_PATTERNS } from '../cli/types.js'
import type { ExecutionResult } from './types.js'

function isRateLimited(result: ExecutionResult): boolean {
  // Check stderr/stdout from the process
  const processOutput = ((result._stderr ?? '') + (result._stdout ?? '')).toLowerCase()
  // Check parsed output (Claude Code returns rate limits as synthetic successful responses)
  const parsedOutput = ((result.output.result ?? '') + (result.output.error ?? '') + (result.output.rawOutput ?? '')).toLowerCase()
  const combined = processOutput + parsedOutput
  return RATE_LIMIT_PATTERNS.some(p => combined.includes(p))
}

function checkRateLimited(result: ExecutionResult, target: CLITarget): boolean {
  if (target.isRateLimited) {
    return target.isRateLimited(result.output, {
      stdout: result._stdout ?? '',
      stderr: result._stderr ?? '',
    })
  }
  return isRateLimited(result)
}

/** Swap --model value in a command array */
function swapModel(command: string[], newModel: string): string[] {
  const swapped = [...command]
  const idx = swapped.indexOf('--model')
  if (idx !== -1 && idx + 1 < swapped.length) {
    swapped[idx + 1] = newModel
  }
  return swapped
}

function buildEnv(): NodeJS.ProcessEnv {
  // Strip Claude Code nesting-guard env var so spawned CLI processes don't
  // refuse to start inside a parent session.
  //
  // OAuth token routing: Doppler stores the Claude auth token as
  // ANTHROPIC_API_KEY (sk-ant-oat01-*), but Claude Code only accepts OAuth
  // tokens via CLAUDE_CODE_OAUTH_TOKEN — passing one as ANTHROPIC_API_KEY
  // returns 401. If the value looks like an OAuth token, move it to the
  // correct var. Regular API keys (sk-ant-api03-*) stay as-is.
  const { CLAUDECODE: _CLAUDECODE, ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN, ...rest } = process.env
  const env: NodeJS.ProcessEnv = { ...rest }
  if (ANTHROPIC_API_KEY?.startsWith('sk-ant-oat')) {
    env.CLAUDE_CODE_OAUTH_TOKEN = ANTHROPIC_API_KEY
  } else if (ANTHROPIC_API_KEY) {
    env.ANTHROPIC_API_KEY = ANTHROPIC_API_KEY
  } else if (CLAUDE_CODE_OAUTH_TOKEN) {
    env.CLAUDE_CODE_OAUTH_TOKEN = CLAUDE_CODE_OAUTH_TOKEN
  }
  return env
}

function spawnCommand(
  command: string[],
  target: CLITarget,
  env: NodeJS.ProcessEnv,
): Promise<ExecutionResult> {
  const [cmd, ...args] = command
  const startTime = Date.now()

  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''

    const child = spawn(cmd, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
      cwd: target.workingDir,
    })

    child.stdout.on('data', (data) => {
      stdout += data.toString()
    })

    child.stderr.on('data', (data) => {
      stderr += data.toString()
    })

    child.on('close', (exitCode) => {
      const durationMs = Date.now() - startTime

      let output: CLIOutput
      if (!target.parseOutput) {
        output = {
          sessionId: `error-${Date.now()}`,
          success: false,
          error: `Adapter '${target.name}' has no parseOutput — use executeQuery instead`,
        }
      } else {
        try {
          output = target.parseOutput(stdout)
        } catch {
          output = {
            sessionId: `error-${Date.now()}`,
            success: false,
            error: stderr || 'Failed to parse output',
            rawOutput: stdout,
          }
        }
      }

      resolve({
        command,
        output,
        durationMs,
        exitCode: exitCode ?? 1,
        _stderr: stderr,
        _stdout: stdout,
      })
    })

    child.on('error', (err) => {
      resolve({
        command,
        output: {
          sessionId: `error-${Date.now()}`,
          success: false,
          error: err.message,
          rawOutput: '',
        },
        durationMs: Date.now() - startTime,
        exitCode: 1,
        _stderr: '',
        _stdout: '',
      })
    })
  })
}

export async function executeCommand(
  command: string[],
  target: CLITarget,
  fallbackModel?: string,
  prompt?: string,
): Promise<ExecutionResult> {
  const env = buildEnv()

  // SDK-based adapters (e.g. claude-agent-sdk) provide executeQuery instead of a CLI binary.
  // Prefer this path when available and a prompt is provided.
  if (target.executeQuery && prompt !== undefined) {
    const sdkResult = await target.executeQuery(prompt, env)
    const result: ExecutionResult = {
      command: sdkResult.command,
      output: sdkResult.output,
      durationMs: sdkResult.durationMs,
      exitCode: sdkResult.exitCode,
    }

    // Check if primary model failed and should fall back.
    // Triggers on: rate limits, auth errors, connection errors, or any failure where
    // the model never actually ran (cost === 0 or undefined).
    const primaryFailed = result.exitCode !== 0 && !result.output.success
    const modelNeverRan = primaryFailed && (result.output.cost === 0 || result.output.cost === undefined)
    const shouldFallback = checkRateLimited(result, target) || modelNeverRan
    if (fallbackModel && shouldFallback) {
      const reason = checkRateLimited(result, target) ? 'rate-limited' : `failed (${result.output.error?.slice(0, 80) ?? 'unknown'})`
      console.error(`Primary model ${reason} (SDK path), falling back to ${fallbackModel}`)
      const sdkFallback = await target.executeQuery(prompt, env, { model: fallbackModel })
      const fallbackResult: ExecutionResult = {
        command: sdkFallback.command,
        output: sdkFallback.output,
        durationMs: sdkFallback.durationMs,
        exitCode: sdkFallback.exitCode,
      }
      if (checkRateLimited(fallbackResult, target)) {
        console.error(`[executor] Both primary and ${fallbackModel} are rate-limited (SDK path) — returning fallback result`)
        const existing = fallbackResult.output.error ?? ''
        fallbackResult.output.error = existing ? `${existing} [both models rate-limited]` : '[both models rate-limited]'
      }
      return fallbackResult
    }

    return result
  }

  const result = await spawnCommand(command, target, env)

  // If primary was rate-limited and a fallback model is available, retry.
  // Rate limits can arrive as exit code 1 (API error) OR exit code 0 with a
  // synthetic "You've hit your limit" response — check both.
  if (fallbackModel && checkRateLimited(result, target)) {
    const fallbackCommand = swapModel(command, fallbackModel)
    console.error(`Primary model rate-limited, falling back to ${fallbackModel}`)
    const fallbackResult = await spawnCommand(fallbackCommand, target, env)

    // If the fallback is also rate-limited, annotate so the caller knows both were tried
    if (checkRateLimited(fallbackResult, target)) {
      const modelIdx = command.indexOf('--model')
      const primaryModel = (modelIdx !== -1 && modelIdx + 1 < command.length) ? command[modelIdx + 1] : 'primary'
      console.error(`[executor] Both ${primaryModel} and ${fallbackModel} are rate-limited — returning fallback result`)
      const existing = fallbackResult.output.error ?? ''
      fallbackResult.output.error = existing ? `${existing} [both models rate-limited]` : '[both models rate-limited]'
    }

    // Clean up internal fields
    delete fallbackResult._stderr
    delete fallbackResult._stdout
    return fallbackResult
  }

  // Clean up internal fields
  delete result._stderr
  delete result._stdout
  return result
}
