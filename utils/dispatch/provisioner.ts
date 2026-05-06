/**
 * Provisioner types for dispatch workflows.
 *
 * Defines the shared contract for environment provisioners
 * that set up context for agent runs.
 */

import type { ProvisionContext } from './provision-context.js'

/**
 * A provisioner sets up and tears down isolated context for a given slug.
 * Each provisioner is responsible for a single named concern (e.g. "github", "database").
 * Provisioners mutate ctx directly instead of returning values.
 */
export interface Provisioner {
  name: string
  /** Names of provisioners that should run before this one when both are in the same run set. Pure ordering hint — no hard requirement implied. */
  runsAfter?: string[]
  provision(ctx: ProvisionContext, slug: string, opts?: Record<string, string>): Promise<void>
  teardown(ctx: ProvisionContext, slug: string): Promise<void>
}
