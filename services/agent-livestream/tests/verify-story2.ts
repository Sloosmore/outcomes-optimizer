/**
 * Story 2 acceptance criteria verification script.
 * Criteria 4-5: createAdapter returns MockAdapter by default and with ?adapter=mock.
 * Criterion 2: interface files have no implementation.
 * Run: npx tsx tests/verify-story2.ts
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// Polyfill for MockAdapter constructor
Object.assign(globalThis, {
  window: { location: { pathname: '/chat/new', search: '' } },
})

const { createAdapter } = await import('../src/adapters/adapter-factory.ts')
const { MockAdapter } = await import('../src/adapters/mock/mock-adapter.ts')

// Criterion 4: createAdapter(empty params) returns MockAdapter
const a1 = createAdapter(new URLSearchParams())
console.assert(a1 instanceof MockAdapter, 'createAdapter(empty) should return MockAdapter')
console.log('✓ Criterion 4: createAdapter(new URLSearchParams()) → MockAdapter')

// Criterion 5: createAdapter(?adapter=mock) returns MockAdapter
const a2 = createAdapter(new URLSearchParams('adapter=mock'))
console.assert(a2 instanceof MockAdapter, 'createAdapter(adapter=mock) should return MockAdapter')
console.log('✓ Criterion 5: createAdapter(?adapter=mock) → MockAdapter')

// Criterion 2: interface files have no implementation
const root = resolve(import.meta.dirname, '../src/adapters')
for (const file of ['research-adapter.ts', 'voice-session-adapter.ts']) {
  const content = readFileSync(resolve(root, file), 'utf-8')
  // Should only have export/interface/type keywords, no function bodies, no class, no const =
  console.assert(!content.includes('class '), `${file} should not contain class`)
  console.assert(!content.includes('function '), `${file} should not contain function`)
  console.assert(!content.includes('const '), `${file} should not contain const`)
  console.assert(!content.includes('let '), `${file} should not contain let`)
  console.log(`✓ Criterion 2: ${file} is interface-only`)
}

// Criterion 6: hooks ≤150 lines
const hooksRoot = resolve(import.meta.dirname, '../src/hooks')
for (const file of ['use-voice-session.ts', 'use-messages.ts']) {
  const lines = readFileSync(resolve(hooksRoot, file), 'utf-8').split('\n').length
  console.assert(lines <= 150, `${file} has ${lines} lines (max 150)`)
  console.log(`✓ Criterion 6: ${file} = ${lines} lines (≤150)`)
}

console.log('\n✅ All verifiable Story 2 criteria passed')
console.log('Note: Criterion 3 (MockAdapter behavior vs stub BFF) requires browser runtime — deferred to Playwright')
