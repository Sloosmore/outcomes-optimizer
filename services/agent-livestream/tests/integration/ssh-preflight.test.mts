import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'

if (!process.env['OPENCLAW_HOST']) {
  describe('test:ssh-preflight', () => {
    it('skipped — OPENCLAW_HOST not set', () => {
      // eslint-disable-next-line no-console -- skip message
      console.log('# OPENCLAW_HOST not set — skipping SSH preflight')
    })
  })
} else {
  const { SshManager } = await import('../../server/adapters/research/ssh-manager.ts')

  describe('test:ssh-preflight', () => {
    const ssh = new SshManager()

    after(() => {
      ssh.close()
    })

    it('can execute a command on OpenClaw via SSH', async () => {
      const result = await ssh.execOnOpenClaw('ls /root')
      assert.ok(
        result.includes('repos') || result.includes('workspace'),
        `Expected 'repos' or 'workspace' in output, got: ${result.substring(0, 200)}`,
      )
    })
  })
}
