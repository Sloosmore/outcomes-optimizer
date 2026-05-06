# agent-media/src/commands

Command implementations for the agent-media CLI:
- `image.ts` — generate images (cost estimate, adapter selection, save to disk)
- `video.ts` — async video generation: `--start` (submit), `--check <id>` (poll), `--download <id>` (fetch to disk), `--jobs` (list)
- `audio.ts` — generate TTS audio from text
- `caption.ts` — Whisper transcription + ASS subtitle burn via ffmpeg
- `read.ts` — AI-powered media description or virality review (Gemini)
- `assemble.ts` — combine video + audio tracks via ffmpeg
- `bulk-image.ts` — generate multiple images from a list of prompts
- `frame.ts` — extract a frame from a video
- `trim.ts` — trim video to a time range
- `merge-audio.ts` — mix audio tracks
- `scrape.ts` — download media from URLs
- `list.ts` — list generated files in the workspace
- `capabilities.ts` — display adapter capabilities and pricing

> E2E verification requirements live in the flow graph — see flow skills via `npx agent-core search "flow/" --type skill`
