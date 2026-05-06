import type { Resource } from '@skill-networks/agent-events'

// Deterministic pseudo-random so visit paths are stable across renders
function prng(seed: string, i: number): number {
  let h = 0
  const s = seed + String(i)
  for (let j = 0; j < s.length; j++) h = ((h << 5) - h + s.charCodeAt(j)) | 0
  return Math.abs(h)
}

// Returns a deterministic pseudo-random walk of `length` unique resource IDs.
// Oldest visit first, current (most recent) last.
export function getMockVisitPath(
  processId: string,
  resources: Resource[],
  length = 5,
): string[] {
  if (resources.length === 0) return []
  const count = Math.min(length, resources.length)
  const visited: string[] = []
  const seen = new Set<string>()
  let idx = prng(processId, 0) % resources.length
  for (let i = 0; i < count; i++) {
    while (seen.has(resources[idx].id)) idx = (idx + 1) % resources.length
    seen.add(resources[idx].id)
    visited.push(resources[idx].id)
    idx = prng(processId, i + 1) % resources.length
  }
  return visited
}
