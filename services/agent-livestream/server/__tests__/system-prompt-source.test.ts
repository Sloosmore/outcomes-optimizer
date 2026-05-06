/**
 * Invariant: there is only ONE source of system-prompt text in this service.
 *
 * Any reference to `instructions:` or `system:` (the LiveKit Agent and AI SDK
 * keys that take a prompt) must either:
 *   (a) live inside server/prompts/, the canonical prompt module, or
 *   (b) be wired to `buildSystemPrompt(...)` — i.e. delegate to (a).
 *
 * Failing this test means someone has introduced a second inline prompt
 * string outside the prompts module.
 */
import { describe, it, expect } from 'vitest'
import { execSync } from 'node:child_process'
import { resolve } from 'node:path'

const SERVER_DIR = resolve(__dirname, '..')
const REPO_ROOT = resolve(__dirname, '../../../..')
const RELATIVE_SERVER = 'services/agent-livestream/server'

interface GrepHit {
  file: string
  line: number
  text: string
}

function grep(pattern: string): GrepHit[] {
  let output: string
  try {
    output = execSync(
      `git grep -n -E ${JSON.stringify(pattern)} -- ${RELATIVE_SERVER}`,
      { cwd: REPO_ROOT, encoding: 'utf-8' },
    )
  } catch (err) {
    // git grep returns exit code 1 when no matches — treat as empty.
    const e = err as { status?: number; stdout?: string }
    if (e.status === 1) return []
    throw err
  }
  return output
    .split('\n')
    .filter((l) => l.length > 0)
    .map((line) => {
      const [file, lineNo, ...rest] = line.split(':')
      return {
        file: file ?? '',
        line: Number.parseInt(lineNo ?? '0', 10),
        text: rest.join(':'),
      }
    })
}

function isInPromptsModule(file: string): boolean {
  return file.includes(`${RELATIVE_SERVER}/prompts/`)
}

function isInTestFile(file: string): boolean {
  return file.includes('/__tests__/') || file.includes('/tests/') || file.endsWith('.test.ts')
}

function delegatesToBuildSystemPrompt(text: string): boolean {
  return /buildSystemPrompt\s*\(/.test(text)
}

describe('system-prompt source invariant', () => {
  it('every `instructions:` outside prompts/ delegates to buildSystemPrompt', () => {
    const hits = grep('\\binstructions:').filter(
      (h) => !isInPromptsModule(h.file) && !isInTestFile(h.file),
    )
    const offenders = hits.filter((h) => !delegatesToBuildSystemPrompt(h.text))
    if (offenders.length > 0) {
      const lines = offenders.map((h) => `  ${h.file}:${h.line}  →  ${h.text.trim()}`).join('\n')
      expect.fail(
        `Found ${offenders.length} \`instructions:\` site(s) outside server/prompts/ that do not call buildSystemPrompt():\n${lines}`,
      )
    }
    // Ensure SERVER_DIR is referenced so unused-vars is happy without disabling lint.
    expect(SERVER_DIR.length).toBeGreaterThan(0)
  })

  it('every `system:` outside prompts/ delegates to buildSystemPrompt', () => {
    const hits = grep('\\bsystem:').filter(
      (h) => !isInPromptsModule(h.file) && !isInTestFile(h.file),
    )
    const offenders = hits.filter((h) => !delegatesToBuildSystemPrompt(h.text))
    if (offenders.length > 0) {
      const lines = offenders.map((h) => `  ${h.file}:${h.line}  →  ${h.text.trim()}`).join('\n')
      expect.fail(
        `Found ${offenders.length} \`system:\` site(s) outside server/prompts/ that do not call buildSystemPrompt():\n${lines}`,
      )
    }
  })
})
