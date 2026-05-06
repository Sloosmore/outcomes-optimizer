import { describe, it, expect } from 'vitest'
import { filterToOkrTree } from './graph.js'

type Row = Record<string, unknown>

function makeResource(id: string, config: Record<string, unknown> | null = null): Row {
  return { id, config }
}

function makeLink(fromId: string, toId: string, linkType = 'parent'): Row {
  return { from_id: fromId, to_id: toId, link_type: linkType }
}

describe('filterToOkrTree - runs link preservation', () => {
  it('preserves a "runs" link where parent is in tree but child is not', () => {
    const resources = [
      makeResource('agent', { size: 'lg' }),
      makeResource('skill', { size: 'md' }),
    ]
    // BFS from 'agent' via a 'parent' link reaches 'agent' but not 'other-skill'
    const links = [
      makeLink('agent', 'skill', 'runs'),
      makeLink('agent', 'other-skill', 'runs'),
    ]
    const { resources: resultResources, links: resultLinks } = filterToOkrTree(resources, links)
    // 'other-skill' is not in resources so it won't appear
    const resourceIds = resultResources.map((r) => r.id)
    expect(resourceIds).toContain('agent')
    expect(resourceIds).toContain('skill')
    // The 'runs' link to 'other-skill' (not in resources but parent is) should be kept
    const linkPairs = resultLinks.map((l) => `${l.from_id}→${l.to_id}`)
    expect(linkPairs).toContain('agent→skill')
    expect(linkPairs).toContain('agent→other-skill')
  })

  it('excludes a "runs" link where neither end is reachable', () => {
    const resources = [
      makeResource('root', { size: 'lg' }),
      makeResource('child', { size: 'md' }),
    ]
    const links = [
      makeLink('root', 'child', 'parent'),
      makeLink('orphan-agent', 'orphan-skill', 'runs'),
    ]
    const { links: resultLinks } = filterToOkrTree(resources, links)
    const linkPairs = resultLinks.map((l) => `${l.from_id}→${l.to_id}`)
    expect(linkPairs).not.toContain('orphan-agent→orphan-skill')
  })

  it('excludes a non-runs link where only from_id is in tree', () => {
    const resources = [
      makeResource('root', { size: 'lg' }),
      makeResource('child', { size: 'md' }),
    ]
    const links = [
      makeLink('root', 'child', 'parent'),
      makeLink('root', 'missing', 'parent'),
    ]
    const { links: resultLinks } = filterToOkrTree(resources, links)
    const linkPairs = resultLinks.map((l) => `${l.from_id}→${l.to_id}`)
    expect(linkPairs).toContain('root→child')
    expect(linkPairs).not.toContain('root→missing')
  })

  it('preserves a "runs" link where both ends are in tree', () => {
    const resources = [
      makeResource('agent', { size: 'lg' }),
      makeResource('skill', { size: 'md' }),
    ]
    const links = [makeLink('agent', 'skill', 'runs')]
    const { links: resultLinks } = filterToOkrTree(resources, links)
    const linkPairs = resultLinks.map((l) => `${l.from_id}→${l.to_id}`)
    expect(linkPairs).toContain('agent→skill')
  })
})

describe('filterToOkrTree - dispatched goal exclusion', () => {
  const baseLinks = [makeLink('root', 'child'), makeLink('root', 'goal')]

  it('excludes a dispatched goal resource (has content, no size key)', () => {
    const resources = [
      makeResource('root', { metric: 'revenue' }),
      makeResource('child', { size: 5 }),
      makeResource('goal', { content: '# Goal\nDeliver X' }), // dispatched goal
    ]
    const { resources: result } = filterToOkrTree(resources, baseLinks)
    const ids = result.map((r) => r.id)
    expect(ids).toContain('root')
    expect(ids).toContain('child')
    expect(ids).not.toContain('goal')
  })

  it('keeps a resource with both content and size', () => {
    const resources = [
      makeResource('root', { metric: 'revenue' }),
      makeResource('child', { content: 'Some description', size: 3 }),
    ]
    const links = [makeLink('root', 'child')]
    const { resources: result } = filterToOkrTree(resources, links)
    expect(result.map((r) => r.id)).toContain('child')
  })

  it('keeps a resource with size=0 (falsy but present)', () => {
    const resources = [
      makeResource('root', { metric: 'revenue' }),
      makeResource('child', { content: 'description', size: 0 }),
    ]
    const links = [makeLink('root', 'child')]
    const { resources: result } = filterToOkrTree(resources, links)
    expect(result.map((r) => r.id)).toContain('child')
  })

  it('keeps a resource with no content field regardless of size absence', () => {
    const resources = [
      makeResource('root', { metric: 'revenue' }),
      makeResource('child', { metric: 'tasks' }),
    ]
    const links = [makeLink('root', 'child')]
    const { resources: result } = filterToOkrTree(resources, links)
    expect(result.map((r) => r.id)).toContain('child')
  })

  it('keeps a resource with null config', () => {
    const resources = [
      makeResource('root', { metric: 'revenue' }),
      makeResource('child', null),
    ]
    const links = [makeLink('root', 'child')]
    const { resources: result } = filterToOkrTree(resources, links)
    expect(result.map((r) => r.id)).toContain('child')
  })
})
