// Usage: OPENAI_API_KEY=xxx npx tsx tests/fixtures/generate-sandbox-audio.ts
import { writeFileSync, mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const outDir = resolve(__dirname)
mkdirSync(outDir, { recursive: true })

const PROMPT = 'Draw me a mermaid flowchart with two nodes, hello and world.'
const VOICE = 'alloy'
const OUT_FILE = resolve(outDir, 'draw-mermaid-prompt.wav')

async function main(): Promise<void> {
  const apiKey = process.env['OPENAI_API_KEY']
  if (!apiKey) throw new Error('OPENAI_API_KEY required')

  console.log('Generating audio fixture...')
  const res = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'tts-1',
      input: PROMPT,
      voice: VOICE,
      response_format: 'wav',
      speed: 0.9,
    }),
  })

  if (!res.ok) throw new Error(`TTS failed: ${res.status} ${await res.text()}`)

  const buffer = await res.arrayBuffer()
  writeFileSync(OUT_FILE, Buffer.from(buffer))
  console.log(`Written: ${OUT_FILE} (${buffer.byteLength} bytes)`)
}

main().catch((e: unknown) => {
  console.error(e)
  process.exit(1)
})
