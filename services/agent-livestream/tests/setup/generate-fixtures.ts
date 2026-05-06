/**
 * Generates PCM16 voice fixtures using OpenAI TTS API.
 * Run: tsx tests/setup/generate-fixtures.ts
 * Requires OPENAI_API_KEY in environment.
 */
import { writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const FIXTURES_DIR = join(import.meta.dirname, '..', 'fixtures')

const VOICE_A_TURNS = [
  'I want to build a YouTube analytics dashboard',
  'It should show views, watch time, and subscriber growth',
  'Pull the data from the YouTube Data API v3',
  'Yes, a daily refresh schedule makes sense',
  'Confirmed, write the goal',
]

const VOICE_B_TURNS = [
  'I want to build a content A/B testing framework',
  'It should test captions against each other across two posts',
  'Measure engagement rate as the primary metric',
  'The constraint is it must use existing agent-instagram posts',
  'Yes, confirmed, write the goal',
]

interface TurnConfig {
  voice: 'a' | 'b'
  turns: string[]
}

const CAMPAIGNS: TurnConfig[] = [
  { voice: 'a', turns: VOICE_A_TURNS },
  { voice: 'b', turns: VOICE_B_TURNS },
]

async function generatePcm16(text: string): Promise<Buffer> {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) throw new Error('OPENAI_API_KEY is required')

  const response = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'tts-1',
      voice: 'alloy',
      input: text,
      response_format: 'pcm',
    }),
  })

  if (!response.ok) {
    const body = await response.text()
    throw new Error(`OpenAI TTS failed (${response.status}): ${body}`)
  }

  return Buffer.from(await response.arrayBuffer())
}

async function main(): Promise<void> {
  if (!existsSync(FIXTURES_DIR)) {
    mkdirSync(FIXTURES_DIR, { recursive: true })
  }

  for (const campaign of CAMPAIGNS) {
    for (let i = 0; i < campaign.turns.length; i++) {
      const turn = campaign.turns[i] ?? ''
      const filename = `voice-${campaign.voice}-turn-${i + 1}.pcm16`
      const filepath = join(FIXTURES_DIR, filename)
      console.warn(`Generating ${filename}: "${turn}"`)
      const pcmData = await generatePcm16(turn)
      writeFileSync(filepath, pcmData)
      console.warn(`  Wrote ${pcmData.length} bytes to ${filepath}`)
    }
  }

  console.warn('\nDone. Generated 10 PCM16 fixtures.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
