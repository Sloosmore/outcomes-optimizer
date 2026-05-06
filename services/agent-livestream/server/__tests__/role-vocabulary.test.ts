/**
 * Story 1 — Role vocabulary invariant.
 *
 * Verifies that no server/ or src/ source file uses the string literal
 * `role: "agent"` or `role: 'agent'` (or equivalent patterns).
 *
 * This test may PASS currently (if no "agent" role is used in production code).
 * It is a regression guard: once we introduce the unified role vocabulary
 * {user, assistant, tool}, the "agent" role must never creep back in.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve, join, extname } from 'node:path'

const SERVICE_ROOT = resolve(__dirname, '../../')
const DIRS_TO_SCAN = [join(SERVICE_ROOT, 'server'), join(SERVICE_ROOT, 'src')]

// Pattern matches: role: "agent", role: 'agent', role:"agent", role:'agent'
// Also matches variations with whitespace around colon
const AGENT_ROLE_PATTERN = /role\s*:\s*["']agent["']/

function collectTsFiles(dir: string, files: string[] = []): string[] {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    // Directory may not exist (e.g. src/__tests__ before creation)
    return files
  }

  for (const entry of entries) {
    const full = join(dir, entry)
    let stat
    try {
      stat = statSync(full)
    } catch {
      continue
    }

    if (stat.isDirectory()) {
      if (entry === '__tests__' || entry === 'node_modules' || entry === 'tests') continue
      collectTsFiles(full, files)
    } else if (stat.isFile() && extname(full) === '.ts' && !full.endsWith('.test.ts')) {
      files.push(full)
    }
  }
  return files
}

describe('role vocabulary invariant', () => {
  it('no server/ or src/ source file uses role: "agent"', () => {
    const violations: Array<{ file: string; line: number; text: string }> = []

    for (const dir of DIRS_TO_SCAN) {
      const tsFiles = collectTsFiles(dir)
      for (const file of tsFiles) {
        const content = readFileSync(file, 'utf-8')
        const lines = content.split('\n')
        lines.forEach((line, idx) => {
          if (AGENT_ROLE_PATTERN.test(line)) {
            violations.push({
              file: file.replace(SERVICE_ROOT + '/', ''),
              line: idx + 1,
              text: line.trim(),
            })
          }
        })
      }
    }

    if (violations.length > 0) {
      const locations = violations
        .map((v) => `  ${v.file}:${v.line}  →  ${v.text}`)
        .join('\n')
      expect.fail(
        `Found ${violations.length} forbidden role: "agent" occurrence(s):\n${locations}\n` +
          'Use role vocabulary {user, assistant, tool} only.',
      )
    }

    expect(violations).toHaveLength(0)
  })
})
