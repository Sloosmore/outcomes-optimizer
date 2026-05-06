import { describe, it, expect } from 'vitest'
import { buildArtifactUrl, parseArtifactHost } from './artifact-url.js'

describe('buildArtifactUrl', () => {
  it('returns correct URL format', () => {
    expect(buildArtifactUrl(3000, 'abc')).toBe('https://artifact-abc-3000.example.com/')
  })
  it('handles sandboxId with hyphens', () => {
    expect(buildArtifactUrl(3000, 'abc-def-123')).toBe('https://artifact-abc-def-123-3000.example.com/')
  })
  it('handles UUID sandboxId', () => {
    expect(buildArtifactUrl(3737, '550e8400-e29b-41d4-a716-446655440000')).toBe(
      'https://artifact-550e8400-e29b-41d4-a716-446655440000-3737.example.com/',
    )
  })
})

describe('parseArtifactHost', () => {
  it('round-trips buildArtifactUrl', () => {
    const url = buildArtifactUrl(3000, 'abc')
    const host = new URL(url).hostname
    expect(parseArtifactHost(host)).toEqual({ sandboxId: 'abc', port: 3000 })
  })
  it('round-trips with hyphenated sandboxId', () => {
    const url = buildArtifactUrl(3000, 'abc-def-123')
    const host = new URL(url).hostname
    expect(parseArtifactHost(host)).toEqual({ sandboxId: 'abc-def-123', port: 3000 })
  })
  it('round-trips with UUID sandboxId', () => {
    const url = buildArtifactUrl(3737, '550e8400-e29b-41d4-a716-446655440000')
    const host = new URL(url).hostname
    expect(parseArtifactHost(host)).toEqual({
      sandboxId: '550e8400-e29b-41d4-a716-446655440000',
      port: 3737,
    })
  })
  it('returns null for non-artifact host', () => {
    expect(parseArtifactHost('not-an-artifact.example.com')).toBeNull()
    expect(parseArtifactHost('example.com')).toBeNull()
    expect(parseArtifactHost('example.com')).toBeNull()
  })
  it('returns null for old dot-separated format', () => {
    expect(parseArtifactHost('3000.abc.example.com')).toBeNull()
  })
})
