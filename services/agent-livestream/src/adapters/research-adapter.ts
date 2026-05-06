export interface ContextBlock {
  summary: string
  files: string[]
}

export interface ResearchAdapter {
  run(prompt: string, options?: { maxTokens?: number }): Promise<ContextBlock>
}
