import type { GraphDataAdapter } from '@skill-networks/agent-events'
import type { Resource, ResourceLink } from '@skill-networks/agent-events'
import type { BffAdapter } from '@skill-networks/contracts/graph'
import { ApiResourcesResponse, ApiResourceLinksResponse } from '@skill-networks/contracts/graph'

export class HttpGraphDataAdapter implements BffAdapter {
  private readonly fetch: (url: string, init?: RequestInit) => Promise<Response>
  constructor(fetch: (url: string, init?: RequestInit) => Promise<Response>) {
    this.fetch = fetch
  }

  async getResources(): Promise<Resource[]> {
    try {
      const res = await this.fetch('/api/resources')
      if (!res.ok) {
        console.warn(`[http-graph] /api/resources returned ${res.status}`)
        return []
      }
      const json: unknown = await res.json()
      return ApiResourcesResponse.parse(json)
    } catch (e) {
      console.warn('[http-graph] getResources failed:', e)
      return []
    }
  }

  async getLinks(): Promise<ResourceLink[]> {
    try {
      const res = await this.fetch('/api/resource-links')
      if (!res.ok) {
        console.warn(`[http-graph] /api/resource-links returned ${res.status}`)
        return []
      }
      // resource_links has no id column — server synthesizes id as `${from_id}__${to_id}`
      const json: unknown = await res.json()
      return ApiResourceLinksResponse.parse(json)
    } catch (e) {
      console.warn('[http-graph] getLinks failed:', e)
      return []
    }
  }

  async getResourceLinks(): Promise<ResourceLink[]> {
    return this.getLinks()
  }

  async getNeighborhood(_resourceIds: string[], _depth: number): Promise<{ nodes: Resource[]; edges: ResourceLink[] }> {
    // TODO: implement server-side neighborhood filtering; currently fetches full graph
    const [nodes, edges] = await Promise.all([this.getResources(), this.getLinks()])
    return { nodes, edges }
  }

  subscribeEvents(_onEvent: (e: import('@skill-networks/contracts/graph').ApiSseEvent) => void): () => void {
    // HttpGraphDataAdapter handles data fetching only; events are handled by RealtimeAdapter
    return () => { /* no-op */ }
  }
}

// Type-check
const _check: GraphDataAdapter = null as unknown as HttpGraphDataAdapter
void _check
