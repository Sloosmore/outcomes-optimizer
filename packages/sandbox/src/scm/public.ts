import type { SourceControlProvider } from './index.js'

export class PublicAdapter implements SourceControlProvider {
  async getCloneUrl(repo: { owner: string; name: string }): Promise<string> {
    return `https://github.com/${repo.owner}/${repo.name}.git`
  }
}
