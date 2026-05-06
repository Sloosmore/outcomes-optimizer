import type { ProviderAdapter, LinkOptions, UnlinkOptions } from './types.js'

export class GitHubAdapter implements ProviderAdapter {
  readonly provider = 'github'
  readonly category = 'tool' as const

  async link(opts: LinkOptions): Promise<void> {
    const { credential, userResourceId, executeAction, supabaseClient } = opts
    if (!userResourceId) {
      throw new Error('GitHubAdapter.link requires opts.userResourceId')
    }
    if (!executeAction) {
      throw new Error('GitHubAdapter.link requires opts.executeAction')
    }
    if (!supabaseClient) {
      throw new Error('GitHubAdapter.link requires opts.supabaseClient')
    }

    await executeAction(
      'store_github_installation',
      {
        userResourceId,
        installationId: credential,
        sandboxName: opts.sandboxName,
        provider: this.provider,
      },
      supabaseClient
    )
  }

  async unlink(opts: UnlinkOptions): Promise<void> {
    const { credentialResourceId, executeAction, supabaseClient } = opts
    if (!credentialResourceId) {
      throw new Error('GitHubAdapter.unlink requires opts.credentialResourceId')
    }
    if (!executeAction) {
      throw new Error('GitHubAdapter.unlink requires opts.executeAction')
    }
    if (!supabaseClient) {
      throw new Error('GitHubAdapter.unlink requires opts.supabaseClient')
    }

    await executeAction(
      'delete_user_credential',
      { credentialResourceId },
      supabaseClient
    )
  }
}
