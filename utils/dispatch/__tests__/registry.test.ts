/**
 * Tests for ProvisionerRegistry.
 */

import { ProvisionerRegistry } from '../registry.js'
import type { Provisioner } from '../provisioner.js'
import { ProvisionContext } from '../provision-context.js'

function mockProvisioner(name: string, order: string[]): Provisioner {
  return {
    name,
    async provision(ctx: ProvisionContext, slug: string): Promise<void> {
      order.push(`provision:${name}`)
      ctx.contextFragments.push(`## ${name}\n\nProvisioned.\n`)
    },
    async teardown(ctx: ProvisionContext, slug: string): Promise<void> {
      order.push(`teardown:${name}`)
    },
  }
}

describe('ProvisionerRegistry', () => {
  it('runs provisioners in declaration (registration) order', async () => {
    const order: string[] = []
    const registry = new ProvisionerRegistry()
    registry.register(mockProvisioner('alpha', order))
    registry.register(mockProvisioner('beta', order))
    registry.register(mockProvisioner('gamma', order))

    const ctx = new ProvisionContext()
    await registry.run(ctx, ['gamma', 'alpha'], 'test-slug')

    // Declaration order: alpha registered first, gamma third
    // So alpha runs before gamma regardless of the order in names[]
    expect(order).toEqual(['provision:alpha', 'provision:gamma'])
  })

  it('tears down in REVERSE declaration order', async () => {
    const order: string[] = []
    const registry = new ProvisionerRegistry()
    registry.register(mockProvisioner('alpha', order))
    registry.register(mockProvisioner('beta', order))
    registry.register(mockProvisioner('gamma', order))

    const ctx = new ProvisionContext()
    await registry.teardown(ctx, ['alpha', 'gamma'], 'test-slug')

    // Reverse of declaration order: gamma first, then alpha
    expect(order).toEqual(['teardown:gamma', 'teardown:alpha'])
  })

  it('throws for unknown provisioner names', async () => {
    const registry = new ProvisionerRegistry()
    registry.register(mockProvisioner('alpha', []))

    const ctx = new ProvisionContext()
    await expect(registry.run(ctx, ['alpha', 'unknown'], 'slug')).rejects.toThrow(
      'Unknown provisioner: "unknown"',
    )
  })

  it('run() populates ctx and returns it', async () => {
    const order: string[] = []
    const registry = new ProvisionerRegistry()
    registry.register(mockProvisioner('alpha', order))
    registry.register(mockProvisioner('beta', order))

    const ctx = new ProvisionContext()
    const result = await registry.run(ctx, ['beta', 'alpha'], 'slug')

    // Returns the same ctx instance
    expect(result).toBe(ctx)
    // Both provisioners pushed fragments in declaration order
    expect(ctx.contextFragments).toHaveLength(2)
    expect(ctx.contextFragments[0]).toContain('alpha')
    expect(ctx.contextFragments[1]).toContain('beta')
  })

  it('passes slug and opts to provisioners', async () => {
    const captured: { slug: string; opts?: Record<string, string> }[] = []
    const p: Provisioner = {
      name: 'capture',
      async provision(ctx: ProvisionContext, slug, opts) {
        captured.push({ slug, opts })
      },
      async teardown(ctx: ProvisionContext) {},
    }

    const registry = new ProvisionerRegistry()
    registry.register(p)

    const ctx = new ProvisionContext()
    await registry.run(ctx, ['capture'], 'my-slug', { key: 'val' })

    expect(captured).toEqual([{ slug: 'my-slug', opts: { key: 'val' } }])
  })
})
