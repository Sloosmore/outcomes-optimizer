export { AnthropicAdapter } from './anthropic.js'
export { GitHubAdapter } from './github.js'
export { UnknownProviderError, AlreadyLinkedError, SandboxUnreachableError, CLIProxyAPINotFoundError } from './types.js'
export type { ProviderAdapter, LinkOptions, UnlinkOptions, SandboxConnection } from './types.js'

import { AnthropicAdapter } from './anthropic.js'
import { GitHubAdapter } from './github.js'
import { UnknownProviderError } from './types.js'
import type { ProviderAdapter } from './types.js'

export function resolveProvider(name: string): ProviderAdapter {
  switch (name.toLowerCase()) {
    case 'anthropic': return new AnthropicAdapter()
    case 'github': return new GitHubAdapter()
    default: throw new UnknownProviderError(name)
  }
}
