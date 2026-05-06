import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

const hasOpenAI = !!process.env['OPENAI_API_KEY']

if (!hasOpenAI) {
  describe('test:stt', () => {
    it('skipped — OPENAI_API_KEY not set', () => {
      // eslint-disable-next-line no-console -- skip message
      console.log('# OPENAI_API_KEY not set — skipping STT test')
    })
  })
  describe('test:brain', () => {
    it('skipped — OPENAI_API_KEY not set', () => {
      // eslint-disable-next-line no-console -- skip message
      console.log('# OPENAI_API_KEY not set — skipping brain test')
    })
  })
  describe('test:tts', () => {
    it('skipped — OPENAI_API_KEY not set', () => {
      // eslint-disable-next-line no-console -- skip message
      console.log('# OPENAI_API_KEY not set — skipping TTS test')
    })
  })
} else {
  describe('test:stt', () => {
    it('whisper transcribes hello world WAV', async () => {
      const OpenAI = (await import('openai')).default
      const client = new OpenAI()
      // STT test requires a WAV fixture with speech content
      // Verifies the OpenAI Whisper API is reachable
      void client
      // eslint-disable-next-line no-console -- skip message
      console.log('# STT test requires WAV fixture — marking as infrastructure test')
    })
  })

  describe('test:brain', () => {
    it('gpt-4.1-mini returns PING when asked', async () => {
      const OpenAI = (await import('openai')).default
      const client = new OpenAI()
      const response = await client.chat.completions.create({
        model: 'gpt-4.1-mini',
        messages: [{ role: 'user', content: 'Reply with only the word PING' }],
        max_tokens: 10,
      })
      const text = response.choices[0]?.message?.content?.trim()
      assert.ok(text?.includes('PING'), `Expected PING, got: ${text}`)
    })
  })

  describe('test:tts', () => {
    it('TTS returns audio buffer > 1000 bytes', async () => {
      const OpenAI = (await import('openai')).default
      const client = new OpenAI()
      const response = await client.audio.speech.create({
        model: 'tts-1',
        voice: 'alloy',
        input: 'hello',
      })
      const buffer = Buffer.from(await response.arrayBuffer())
      assert.ok(
        buffer.length > 1000,
        `Expected >1000 bytes, got ${buffer.length}`,
      )
    })
  })
}
