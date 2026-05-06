export interface SourceControlProvider {
  getCloneUrl(repo: { owner: string; name: string }): Promise<string>
}

export { GitHubAppAdapter } from './github.js'
export { PublicAdapter } from './public.js'
