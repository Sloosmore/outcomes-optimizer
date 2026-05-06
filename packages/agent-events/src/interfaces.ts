import type { AgentEvent, Resource, ResourceLink } from './schemas.js'

/** Emit input: process_id and process_name are optional because PrefilledEventEmitterAdapter injects them. */
export type EmitInput = Omit<AgentEvent, 'id' | 'ts' | 'process_id' | 'process_name'> & Partial<Pick<AgentEvent, 'process_id' | 'process_name'>>

export interface EventEmitterAdapter {
  emit(event: EmitInput): void  // void — never awaited, never throws
}

export interface EventStreamAdapter {
  subscribe(onEvent: (e: AgentEvent) => void): () => void  // returns unsubscribe fn
}

export interface EventHistoryAdapter {
  getHistory(limit?: number): Promise<AgentEvent[]>
}

export interface GraphDataAdapter {
  getNeighborhood(resourceIds: string[], depth: number): Promise<{ nodes: Resource[], edges: ResourceLink[] }>
  getResources(): Promise<Resource[]>
  getLinks(): Promise<ResourceLink[]>
}

export interface NodeRenderProps {
  resource: Resource
  selected: boolean
}

// Minimal ComponentType definition to avoid React as a runtime dependency
type ComponentType<P> = (props: P) => unknown

export interface NodeRendererRegistry {
  register(type: string, component: ComponentType<NodeRenderProps>): void
  get(type: string): ComponentType<NodeRenderProps>
  setDefault(component: ComponentType<NodeRenderProps>): void
}
