import { describe, it, expect, beforeEach } from 'vitest'
import { InMemoryOntologyAdapter } from '../adapters/in-memory-ontology-adapter.js'

describe('listProcesses — leaf-only filtering', () => {
  let adapter: InMemoryOntologyAdapter

  beforeEach(() => {
    adapter = new InMemoryOntologyAdapter()
  })

  it('returns only the leaf segment when a root has 3 segments (2 completed, 1 active leaf)', async () => {
    // Create root process (segment 1)
    const rootId = await adapter.initProcess('proc-a')
    // Sleep twice to create segment 2 and segment 3
    const { new_segment_id: seg2Id } = await adapter.sleepProcess(rootId, '1 minutes')
    const { new_segment_id: seg3Id } = await adapter.sleepProcess(seg2Id, '1 minutes')

    const results = await adapter.listProcesses()

    expect(results).toHaveLength(1)
    expect(results[0].id).toBe(seg3Id)
  })

  it('returns a non-sleeping process (root_process_id = id) unchanged', async () => {
    const id = await adapter.initProcess('proc-simple')

    const results = await adapter.listProcesses()

    expect(results).toHaveLength(1)
    expect(results[0].id).toBe(id)
  })

  it('returns one leaf per root when multiple roots exist', async () => {
    // Root A with 2 segments
    const rootA = await adapter.initProcess('proc-root-a')
    const { new_segment_id: leafA } = await adapter.sleepProcess(rootA, '1 minutes')

    // Root B with no sleep (single segment)
    const rootB = await adapter.initProcess('proc-root-b')

    const results = await adapter.listProcesses()

    expect(results).toHaveLength(2)
    const ids = results.map(r => r.id)
    expect(ids).toContain(leafA)
    expect(ids).toContain(rootB)
    expect(ids).not.toContain(rootA)
  })
})
