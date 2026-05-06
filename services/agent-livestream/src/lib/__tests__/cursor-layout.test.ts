import { describe, it, expect } from 'vitest'
import { layoutCursors } from '@/lib/cursor-layout'
import { CURSOR_ORBIT_RADIUS_PX } from '@/constants'

describe('layoutCursors', () => {
  const node = { x: 100, y: 200 }
  const positions = new Map([['user:stan', node]])
  const events = new Map<string, string>()

  it('places a single cursor at the node center', () => {
    const cursors = new Map([
      ['user:stan', [{ process_id: 'p1', process_name: 'solo' }]],
    ])
    const out = layoutCursors(cursors, positions, events)
    expect(out).toHaveLength(1)
    expect(out[0]?.x).toBe(node.x)
    expect(out[0]?.y).toBe(node.y)
  })

  it('orbits multiple cursors around the node center at different positions', () => {
    const cursors = new Map([
      ['user:stan', [
        { process_id: 'p1', process_name: 'sandbox-dns' },
        { process_id: 'p2', process_name: 'restart-fix' },
      ]],
    ])
    const out = layoutCursors(cursors, positions, events)
    expect(out).toHaveLength(2)

    // Neither cursor sits at the exact node center when N > 1.
    expect(out[0]?.x === node.x && out[0]?.y === node.y).toBe(false)
    expect(out[1]?.x === node.x && out[1]?.y === node.y).toBe(false)

    // The two cursors have distinct positions (the bug symptom was identical positions).
    expect(out[0]?.x === out[1]?.x && out[0]?.y === out[1]?.y).toBe(false)

    // Each cursor sits at the expected orbit radius from the node center.
    for (const c of out) {
      const r = Math.hypot(c.x - node.x, c.y - node.y)
      expect(r).toBeCloseTo(CURSOR_ORBIT_RADIUS_PX, 5)
    }
  })

  it('evenly spaces three cursors on the orbit circle', () => {
    const cursors = new Map([
      ['user:stan', [
        { process_id: 'a', process_name: 'a' },
        { process_id: 'b', process_name: 'b' },
        { process_id: 'c', process_name: 'c' },
      ]],
    ])
    const out = layoutCursors(cursors, positions, events)
    expect(out).toHaveLength(3)

    for (const c of out) {
      expect(Math.hypot(c.x - node.x, c.y - node.y)).toBeCloseTo(CURSOR_ORBIT_RADIUS_PX, 5)
    }

    // All three pairs differ in at least one axis.
    const pairs = [
      [out[0], out[1]],
      [out[1], out[2]],
      [out[0], out[2]],
    ] as const
    for (const [a, b] of pairs) {
      expect(a!.x === b!.x && a!.y === b!.y).toBe(false)
    }
  })

  it('drops cursors whose resource has no terrain position', () => {
    const cursors = new Map([
      ['user:stan', [{ process_id: 'p1', process_name: 'placed' }]],
      ['off-graph', [{ process_id: 'p2', process_name: 'orphan' }]],
    ])
    const out = layoutCursors(cursors, positions, events)
    expect(out).toHaveLength(1)
    expect(out[0]?.id).toBe('p1')
  })

  it('threads latestEvents lookup through to lastTool', () => {
    const cursors = new Map([
      ['user:stan', [{ process_id: 'p1', process_name: 'solo' }]],
    ])
    const withEvent = new Map([['p1', 'Bash']])
    const out = layoutCursors(cursors, positions, withEvent)
    expect(out[0]?.lastTool).toBe('Bash')
  })
})
