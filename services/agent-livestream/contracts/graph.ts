import { z } from 'zod'
import { ResourceSchema, ResourceLinkSchema, AgentEventSchema } from '@skill-networks/agent-events'

export const ApiResourcesResponse = z.array(ResourceSchema)
export const ApiResourceLinksResponse = z.array(ResourceLinkSchema)
export const ApiSseEvent = AgentEventSchema
export const ApiGraphResponse = z.object({
  resources: z.array(ResourceSchema),
  links: z.array(ResourceLinkSchema),
})
export const ApiResourceTypesResponse = z.array(z.string())

export interface BffAdapter {
  getResources(): Promise<ApiResourcesResponse>
  getResourceLinks(): Promise<ApiResourceLinksResponse>
  subscribeEvents(onEvent: (e: ApiSseEvent) => void): () => void
}

export type ApiResourcesResponse = z.infer<typeof ApiResourcesResponse>
export type ApiResourceLinksResponse = z.infer<typeof ApiResourceLinksResponse>
export type ApiSseEvent = z.infer<typeof ApiSseEvent>
export type ApiGraphResponse = z.infer<typeof ApiGraphResponse>
export type ApiResourceTypesResponse = z.infer<typeof ApiResourceTypesResponse>
