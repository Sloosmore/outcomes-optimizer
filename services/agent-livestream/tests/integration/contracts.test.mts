import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  ResearchDispatch,
  ArtifactReady,
  BackgroundTaskUpdate,
  WorkerError,
  WorkerHeartbeat,
} from '../../src/contracts/livekit-streams.ts'

describe('test:contracts-livekit', () => {
  describe('ResearchDispatch', () => {
    it('parses valid data', () => {
      const result = ResearchDispatch.parse({
        prompt: 'What is the meaning of life?',
        chatId: '123e4567-e89b-12d3-a456-426614174000',
      })
      assert.equal(result.prompt, 'What is the meaning of life?')
      assert.equal(result.chatId, '123e4567-e89b-12d3-a456-426614174000')
    })

    it('throws on invalid data (missing prompt)', () => {
      assert.throws(() => {
        ResearchDispatch.parse({ chatId: '123e4567-e89b-12d3-a456-426614174000' })
      })
    })

    it('throws on invalid data (non-uuid chatId)', () => {
      assert.throws(() => {
        ResearchDispatch.parse({ prompt: 'test', chatId: 'not-a-uuid' })
      })
    })
  })

  describe('ArtifactReady', () => {
    it('parses valid data', () => {
      const result = ArtifactReady.parse({ port: 3000, summary: 'App running on port 3000' })
      assert.equal(result.port, 3000)
      assert.equal(result.summary, 'App running on port 3000')
    })

    it('throws on invalid data (port out of range)', () => {
      assert.throws(() => {
        ArtifactReady.parse({ port: 0, summary: 'bad' })
      })
    })

    it('throws on invalid data (missing summary)', () => {
      assert.throws(() => {
        ArtifactReady.parse({ port: 8080 })
      })
    })
  })

  describe('BackgroundTaskUpdate', () => {
    it('parses valid data', () => {
      const result = BackgroundTaskUpdate.parse({ summary: 'Processing...' })
      assert.equal(result.summary, 'Processing...')
    })

    it('throws on invalid data (missing summary)', () => {
      assert.throws(() => {
        BackgroundTaskUpdate.parse({})
      })
    })
  })

  describe('WorkerError', () => {
    it('parses valid data', () => {
      const result = WorkerError.parse({ message: 'Something went wrong' })
      assert.equal(result.message, 'Something went wrong')
    })

    it('throws on invalid data (missing message)', () => {
      assert.throws(() => {
        WorkerError.parse({})
      })
    })
  })

  describe('WorkerHeartbeat', () => {
    it('parses valid data', () => {
      const result = WorkerHeartbeat.parse({ status: 'running', elapsedMs: 1234 })
      assert.equal(result.status, 'running')
      assert.equal(result.elapsedMs, 1234)
    })

    it('throws on invalid data (missing elapsedMs)', () => {
      assert.throws(() => {
        WorkerHeartbeat.parse({ status: 'running' })
      })
    })

    it('throws on invalid data (elapsedMs not a number)', () => {
      assert.throws(() => {
        WorkerHeartbeat.parse({ status: 'running', elapsedMs: 'fast' })
      })
    })
  })
})
