import { parseArtifactTag } from './artifact-parser.ts'
import { buildArtifactUrl } from '../shared/artifact-url.ts'

describe('parseArtifactTag', () => {
  it('returns null for text without a tag', () => {
    expect(parseArtifactTag('no tag here')).toBeNull()
  })

  it('parses port-based form', () => {
    const result = parseArtifactTag('<open_artifact port="3737" label="Diagram" />')
    expect(result).toEqual({ port: 3737, label: 'Diagram' })
  })

  it('parses url-based form and extracts port from URL', () => {
    const result = parseArtifactTag('<open_artifact url="http://localhost:3737/view/abc" label="Diagram" />')
    expect(result).toEqual({ port: 3737, label: 'Diagram', directUrl: 'http://localhost:3737/view/abc' })
  })

  it('falls back to type attribute for label', () => {
    const result = parseArtifactTag('<open_artifact port="3001" type="Mermaid" />')
    expect(result).not.toBeNull()
    expect(result!.label).toBe('Mermaid')
  })

  it('defaults label to Artifact', () => {
    const result = parseArtifactTag('<open_artifact port="3001" />')
    expect(result).not.toBeNull()
    expect(result!.label).toBe('Artifact')
  })

  it('rejects out-of-range port', () => {
    expect(parseArtifactTag('<open_artifact port="99999" label="X" />')).toBeNull()
  })

  it('parses optional path attribute', () => {
    const result = parseArtifactTag('<open_artifact port="3737" label="X" path="view/foo" />')
    expect(result).not.toBeNull()
    expect(result!.path).toBe('view/foo')
  })
})

describe('buildArtifactUrl', () => {
  it('returns the artifact-router single-label hostname format', () => {
    expect(buildArtifactUrl(3737, 'sandbox-abc')).toBe('https://artifact-sandbox-abc-3737.example.com/')
  })

  it('handles sandboxId with hyphens', () => {
    expect(buildArtifactUrl(3737, 'abc-def-123')).toBe('https://artifact-abc-def-123-3737.example.com/')
  })

  it('handles simple sandboxId', () => {
    expect(buildArtifactUrl(3000, 'abc')).toBe('https://artifact-abc-3000.example.com/')
  })
})
