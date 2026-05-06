import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// openai-realtime adapter was removed; __injectAudio test hook no longer exists — re-enable when a production adapter with __injectAudio support is available
test.skip(true, 'openai-realtime adapter removed; __injectAudio hook unavailable')

const FIXTURES_DIR = join(import.meta.dirname, 'fixtures')
const EXPECTED_TURNS = [
  'I want to build a content A/B testing framework',
  'It should test captions against each other across two posts',
  'Measure engagement rate as the primary metric',
  'The constraint is it must use existing agent-instagram posts',
  'Yes, confirmed, write the goal',
]

function loadFixture(turn: number): string {
  const filepath = join(FIXTURES_DIR, `voice-b-turn-${turn}.pcm16`)
  return readFileSync(filepath).toString('base64')
}

function wordMatchRatio(expected: string, actual: string): number {
  const expectedWords = expected.toLowerCase().split(/\s+/)
  const actualWords = actual.toLowerCase().split(/\s+/)
  const matched = expectedWords.filter((w) => actualWords.includes(w))
  return matched.length / expectedWords.length
}

interface TranscriptEntry {
  role: 'user' | 'assistant'
  content: string
}

test.describe('Voice Campaign B — Content A/B Testing', () => {
  test('voice turn 1 transcribes', async ({ page }) => {
    const pcm16Base64 = loadFixture(1)
    await page.goto('/chat/new?adapter=openai-realtime&autostart=true')

    await page.evaluate((audio) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).__injectAudio(audio)
    }, pcm16Base64)

    const transcript = await page.waitForFunction(
      () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const transcripts = (window as any).__transcripts as TranscriptEntry[] | undefined
        if (!transcripts?.length) return null
        const first = transcripts[0]
        if (first?.role === 'user' && first.content.length > 0) return first.content
        return null
      },
      { timeout: 15_000 },
    )

    const text = await transcript.jsonValue()
    expect(text).toBeTruthy()
    const expected = EXPECTED_TURNS[0] ?? ''
    expect(wordMatchRatio(expected, text as string)).toBeGreaterThan(0.8)
  })

  test('5-turn voice campaign', async ({ page }) => {
    await page.goto('/chat/new?adapter=openai-realtime&autostart=true')

    for (let i = 1; i <= 5; i++) {
      const pcm16Base64 = loadFixture(i)
      await page.evaluate((audio) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (window as any).__injectAudio(audio)
      }, pcm16Base64)

      await page.waitForFunction(
        (expectedCount) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const transcripts = (window as any).__transcripts as TranscriptEntry[] | undefined
          return (transcripts?.length ?? 0) >= expectedCount
        },
        i * 2,
        { timeout: 30_000 },
      )
    }

    const transcripts = await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (window as any).__transcripts as TranscriptEntry[]
    })

    expect(transcripts).toHaveLength(10)

    // Final assistant response should reference concept from turn 1
    const lastAssistant = transcripts[transcripts.length - 1]
    expect(lastAssistant?.role).toBe('assistant')
    expect(lastAssistant?.content.toLowerCase()).toMatch(/a\/b|testing|framework|content/)
  })
})
