import { z } from 'zod'

export const ProvisionRequest = z.object({
  publicKey: z.string().regex(/^ssh-ed25519\s+[A-Za-z0-9+/]+=*(\s+\S+)?$/, 'Must be an ssh-ed25519 public key'),
})

export const ProvisionResponse = z.object({
  status: z.literal('provisioning'),
  resourceId: z.string(),
})

export const SandboxStatusResponse = z.object({
  status: z.string(),
  ip: z.string().optional(),
  resourceId: z.string(),
})

export const SshAccessResponse = z.object({
  allowed: z.literal(true),
  ip: z.string(),
  keyPath: z.string(),
})

export const ReadyRequest = z.object({
  resourceId: z.string().uuid(),
  ip: z.string().regex(/^(\d{1,3}\.){3}\d{1,3}$|^[0-9a-f:]+$/i, 'Must be a valid IP address'),
  hetznerServerId: z.string().regex(/^\d*$/, 'Must be a numeric Hetzner server ID'),
})

export const ReadyResponse = z.object({
  success: z.literal(true),
})

export type ProvisionRequest = z.infer<typeof ProvisionRequest>
export type ProvisionResponse = z.infer<typeof ProvisionResponse>
export type SandboxStatusResponse = z.infer<typeof SandboxStatusResponse>
export type SshAccessResponse = z.infer<typeof SshAccessResponse>
export type ReadyRequest = z.infer<typeof ReadyRequest>
export type ReadyResponse = z.infer<typeof ReadyResponse>

export const RepoCloneRequest = z.object({
  repo: z.string().regex(/^[A-Za-z0-9._-]+$/, 'Invalid repo name'),
})
export const RepoCloneResponse = z.object({
  cloneUrl: z.string(),
})
export type RepoCloneRequest = z.infer<typeof RepoCloneRequest>
export type RepoCloneResponse = z.infer<typeof RepoCloneResponse>
