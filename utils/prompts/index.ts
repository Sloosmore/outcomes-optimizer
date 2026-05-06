import { readFileSync } from 'fs'
import { resolve } from 'path'
import { dirname } from 'path'
import { fileURLToPath } from 'url'
const __dirname = dirname(fileURLToPath(import.meta.url))

export type PolicyType = 'value_based' | 'policy_gradient' | 'actor_critic'

interface PolicyDefinition {
  name: string
  description: string
  prompt: string
}

/**
 * Load the optimization framework prompt.
 */
export function loadOptimizationPrompt(): string {
  const path = resolve(__dirname, 'optimization.md')
  try {
    return readFileSync(path, 'utf-8')
  } catch (err) {
    throw new Error(`Failed to load optimization prompt from ${path}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/**
 * Load a policy prompt by type.
 */
export function loadPolicyPrompt(type: PolicyType): string {
  const path = resolve(__dirname, 'policies.json')
  try {
    const policies: Record<PolicyType, PolicyDefinition> = JSON.parse(readFileSync(path, 'utf-8'))
    const policy = policies[type]
    if (!policy) {
      throw new Error(`Unknown policy type: ${type}`)
    }
    return policy.prompt
  } catch (err) {
    throw new Error(`Failed to load policy prompt: ${err instanceof Error ? err.message : String(err)}`)
  }
}
