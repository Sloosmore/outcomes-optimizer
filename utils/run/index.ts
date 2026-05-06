#!/usr/bin/env npx tsx

import 'dotenv/config'
import { getCLITarget, runPreflight, runPostflight } from '../cli/index.js'
import { syncSkills } from '../sync/index.js'
import { executeCommand } from './executor.js'
import type { RunInput, RunResult } from './types.js'
import { MAX_PROMPT_LENGTH } from '../types.js'

function validatePrompt(prompt: string): string {
  const trimmed = prompt.trim()
  if (trimmed.length === 0) {
    throw new Error('Prompt cannot be empty')
  }
  if (trimmed.length > MAX_PROMPT_LENGTH) {
    throw new Error(`Prompt exceeds maximum length of ${MAX_PROMPT_LENGTH.toLocaleString()} characters`)
  }
  return trimmed
}

export async function run(input: RunInput): Promise<RunResult> {
  const validatedPrompt = validatePrompt(input.prompt)
  const target = getCLITarget()
  target.validateEnvironment()

  // Step 1: Run preflight hooks (e.g., Codex config/AGENTS setup)
  await runPreflight(target)

  // Step 2: Sync skills to CLI target directory
  const syncResults = syncSkills(input.userSkillsRoot ? { userSkillsRoot: input.userSkillsRoot } : undefined)

  const failedSyncs = syncResults.filter(r => !r.success)
  if (failedSyncs.length > 0) {
    throw new Error(
      `Failed to sync skills:\n${failedSyncs.map(r => `  ${r.skillName}: ${r.error}`).join('\n')}`
    )
  }

  // Step 3: Execute CLI command
  const command = target.buildCommand(validatedPrompt)
  const execution = await executeCommand(command, target, target.fallbackModel, validatedPrompt)

  // Step 4: Run postflight hooks (best-effort, errors logged but don't fail run)
  await runPostflight(target, {
    sessionId: execution.output.sessionId,
    success: execution.output.success,
    cost: execution.output.cost,
    durationMs: execution.output.durationMs,
  })

  return {
    sync: syncResults,
    execution,
  }
}

// CLI entrypoint
async function main() {
  const prompt = process.argv[2]
  if (!prompt) {
    console.error('Usage: npx tsx utils/run/index.ts "<prompt>"')
    process.exit(1)
  }

  try {
    const result = await run({ prompt })
    console.log(JSON.stringify(result, null, 2))
    process.exit(result.execution.output.success ? 0 : 1)
  } catch (err) {
    console.error('Run failed:', (err as Error).message)
    process.exit(1)
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
}

export type { RunInput, RunResult, ExecutionResult } from './types.js'
