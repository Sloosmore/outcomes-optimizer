# agent-media/src/adapters

Stateless media adapter layer. Defines the `MediaAdapter` interface (`types.ts`) and implements four concrete adapters:

- `gemini.ts` — `GeminiImageAdapter`: image generation via Gemini 3 Pro Image Preview (inline base64 response)
- `google.ts` — `GoogleAdapter`: video generation via Google Veo API (async, poll `predictLongRunning`)
- `fal.ts` — `FalAdapter`: video generation via fal.ai Veo 3.1 Fast (async queue, image-to-video support)
- `openai.ts` — `OpenAIAdapter`: image generation via DALL-E 3 (Vercel AI SDK) and audio via OpenAI TTS

Read adapters live in `read-types.ts` / `read-registry.ts` and are used by the `read` command.

The registry (`registry.ts`) supports per-modality defaults, auth env-var checking, and capability filtering.

> E2E verification requirements live in the flow graph — see flow skills via `npx agent-core search "flow/" --type skill`
