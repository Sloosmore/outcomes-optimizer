import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

if (!process.env['OPENCLAW_HOST']) {
  // Skip all tests if SSH host is not configured
  describe('test:worker-happy', () => {
    it('skipped — OPENCLAW_HOST not set', () => {
      // eslint-disable-next-line no-console -- skip message
      console.log('OPENCLAW_HOST not set — skipping worker tests')
    })
  })
  describe('test:worker-timeout', () => {
    it('skipped — OPENCLAW_HOST not set', () => {
      // eslint-disable-next-line no-console -- skip message
      console.log('OPENCLAW_HOST not set — skipping worker timeout test')
    })
  })
  describe('test:worker-ssh-ctx', () => {
    it('skipped — OPENCLAW_HOST not set', () => {
      // eslint-disable-next-line no-console -- skip message
      console.log('OPENCLAW_HOST not set — skipping worker SSH context test')
    })
  })
} else {
  const { runSandboxAgent } = await import(
    '../../server/adapters/research/sandbox-agent-runner.ts'
  )

  const host = process.env['OPENCLAW_HOST'] ?? ''
  const privateKey = process.env['OPENCLAW_SSH_KEY'] ?? ''
  const sandboxId = process.env['SANDBOX_ID'] ?? 'test-sandbox'

  describe('test:worker-happy', () => {
    it('sandbox runner can run a research query via SSH', async () => {
      const result = await runSandboxAgent('list files in /root', {
        host,
        privateKey,
        sandboxId,
        timeoutMs: 60_000,
      })

      assert.ok(result.summary, 'Expected a non-empty summary')
      assert.ok(result.summary.length > 0, 'Summary should contain filesystem output')
    })
  })

  describe('test:worker-timeout', () => {
    it('sandbox runner rejects within 5s of timeoutMs: 3000', async () => {
      const start = Date.now()

      await assert.rejects(
        async () => {
          await runSandboxAgent('sleep 60', {
            host,
            privateKey,
            sandboxId,
            timeoutMs: 3000,
          })
        },
        (err: unknown) => {
          assert.ok(err instanceof Error, 'Expected an Error to be thrown')
          return true
        },
      )

      const elapsed = Date.now() - start
      assert.ok(elapsed < 5000, `Expected rejection within 5s, but took ${elapsed}ms`)
    })
  })

  describe('test:worker-ssh-ctx', () => {
    it('sandbox runner returns a summary when script outputs JSON', async () => {
      const result = await runSandboxAgent('echo hello from sandbox', {
        host,
        privateKey,
        sandboxId,
        timeoutMs: 30_000,
      })
      assert.ok(typeof result.summary === 'string', 'Expected summary to be a string')
    })
  })
}
