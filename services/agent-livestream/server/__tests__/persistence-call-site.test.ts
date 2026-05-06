/**
 * Story 1 — Persistence call-site invariant.
 *
 * Verifies that exactly ONE `messages.create(` call site exists in server/
 * source code (excluding tests and node_modules).
 *
 * The single call site lives in lib/persist-message.ts (persistTurn).
 * Both the voice agent and the chat stream route call persistTurn — never
 * messages.create() directly — so this test passes (green state).
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve, join, extname } from 'node:path'

const SERVICE_ROOT = resolve(__dirname, '../../')
const SERVER_DIR = join(SERVICE_ROOT, 'server')

function collectTsFiles(dir: string, files: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) {
      // Skip test directories and node_modules
      if (entry === '__tests__' || entry === 'node_modules' || entry === 'tests') continue
      collectTsFiles(full, files)
    } else if (stat.isFile() && extname(full) === '.ts' && !full.endsWith('.test.ts')) {
      files.push(full)
    }
  }
  return files
}

describe('persistence call-site invariant', () => {
  it('exactly ONE messages.create( call site exists in server/ source', () => {
    const tsFiles = collectTsFiles(SERVER_DIR)
    expect(tsFiles.length, 'Should find at least one server/ .ts file').toBeGreaterThan(0)

    const callSites: Array<{ file: string; line: number; text: string }> = []

    for (const file of tsFiles) {
      const content = readFileSync(file, 'utf-8')
      const lines = content.split('\n')
      lines.forEach((line, idx) => {
        if (line.includes('messages.create(')) {
          callSites.push({ file: file.replace(SERVICE_ROOT + '/', ''), line: idx + 1, text: line.trim() })
        }
      })
    }

    if (callSites.length !== 1) {
      const locations = callSites
        .map((cs) => `  ${cs.file}:${cs.line}  →  ${cs.text}`)
        .join('\n')
      const msg =
        callSites.length === 0
          ? 'No messages.create( call sites found — expected exactly 1'
          : `Found ${callSites.length} messages.create( call sites — expected exactly 1:\n${locations}`
      expect.fail(msg)
    }

    expect(callSites).toHaveLength(1)
  })
})
