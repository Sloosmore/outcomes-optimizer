/**
 * ProvisionerRegistry — manages a set of provisioners and orchestrates
 * their lifecycle in declaration order, respecting runsAfter constraints.
 */

import { fileURLToPath } from 'url'
import type { Provisioner } from './provisioner.js'
import type { ProvisionContext } from './provision-context.js'

export class ProvisionerRegistry {
  private provisioners: Provisioner[] = []

  register(p: Provisioner): void {
    this.provisioners.push(p)
  }

  // Inter-provisioner communication happens exclusively via ctx — no process.env
  // side-effects. Provisioners read upstream outputs from ctx fields directly
  // (e.g. ctx.databaseUrl set by supabase-branch). Loose coupling by design.
  //
  // Per-step start/end logs are emitted so a stuck dispatch is identifiable from
  // the tmux pane alone — a silent provisioner used to look identical to a fully
  // healthy one mid-vite-build, costing ~30min of debugging per occurrence.
  async run(
    ctx: ProvisionContext,
    names: string[],
    slug: string,
    opts?: Record<string, string>,
  ): Promise<ProvisionContext> {
    const matched = this.resolve(names)
    for (const p of matched) {
      const startedAt = Date.now()
      // eslint-disable-next-line no-console -- provision is a CLI subprocess; stdout is its progress channel.
      console.log(`[provision] ${p.name}: starting`)
      try {
        await p.provision(ctx, slug, opts)
      } catch (err) {
        const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1)
        // eslint-disable-next-line no-console -- failure must be visible in the pane, not just thrown silently up.
        console.error(`[provision] ${p.name}: FAILED after ${elapsedSec}s — ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`)
        throw err
      }
      const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1)
      // eslint-disable-next-line no-console -- see above.
      console.log(`[provision] ${p.name}: done (${elapsedSec}s)`)
    }
    return ctx
  }

  async teardown(ctx: ProvisionContext, names: string[], slug: string): Promise<void> {
    const matched = this.resolve(names).reverse()
    for (const p of matched) {
      await p.teardown(ctx, slug)
    }
  }

  /**
   * Resolves names to registered provisioners, applying topological sort
   * based on runsAfter declarations. When both a provisioner and its declared
   * dependency are in the run set, the dependency runs first.
   * Preserves declaration order for provisioners with no ordering constraint.
   * Throws if any requested name is not registered, or if a declared dependency
   * references an unregistered provisioner name.
   */
  private resolve(names: string[]): Provisioner[] {
    // Validate all requested names are registered
    const matched: Provisioner[] = []
    for (const name of names) {
      const found = this.provisioners.find((p) => p.name === name)
      if (!found) {
        throw new Error(`Unknown provisioner: "${name}"`)
      }
      matched.push(found)
    }

    // Preserve declaration (registration) order as the base ordering
    const inRunSet = this.provisioners.filter((p) => matched.includes(p))

    // Validate that all runsAfter references point to registered provisioners
    for (const p of inRunSet) {
      for (const dep of p.runsAfter ?? []) {
        const depRegistered = this.provisioners.find((r) => r.name === dep)
        if (!depRegistered) {
          throw new Error(
            `Provisioner "${p.name}" declares runsAfter "${dep}" which is not registered`,
          )
        }
      }
    }

    // Topological sort: respect runsAfter when both provisioner and dependency
    // are in the run set. Falls back to declaration order when no constraint applies.
    return topologicalSort(inRunSet)
  }
}

/**
 * Sorts provisioners respecting runsAfter constraints, preserving relative
 * declaration order when there is no dependency relationship between two nodes.
 */
function topologicalSort(provisioners: Provisioner[]): Provisioner[] {
  const nameSet = new Set(provisioners.map((p) => p.name))
  const inProgress = new Set<string>()
  const completed = new Set<string>()
  const result: Provisioner[] = []

  function visit(p: Provisioner): void {
    if (completed.has(p.name)) return
    if (inProgress.has(p.name)) {
      throw new Error(`Circular dependency detected in provisioners: "${p.name}"`)
    }
    inProgress.add(p.name)

    // Visit declared dependencies that are in the run set first
    for (const depName of p.runsAfter ?? []) {
      if (nameSet.has(depName)) {
        const dep = provisioners.find((r) => r.name === depName)!
        visit(dep)
      }
    }

    inProgress.delete(p.name)
    completed.add(p.name)
    result.push(p)
  }

  // Iterate in declaration order to preserve it as the tiebreaker
  for (const p of provisioners) {
    visit(p)
  }

  return result
}

export function main(): void {
  console.log('Usage: registry.ts — import and use ProvisionerRegistry programmatically')
  console.log('  registry.register(provisioner)')
  console.log('  registry.run(ctx, names, slug, opts)')
  console.log('  registry.teardown(ctx, names, slug)')
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  main()
}
