# agent-media/src/utils

Shared utilities for agent-media:
- `auth.ts` — `isInterceptorActive()`: detects credential-proxy interceptor via `globalThis.__nativeFetch`; `getGoogleApiKey()` / `getOpenAIApiKey()`: reads API keys from env with clear error messages
- `fetch.ts` — `getProxyFetch()`: wraps `globalThis.fetch` with a configurable `AbortSignal.timeout`; `safeJsonParse()`: enforces `MAX_RESPONSE_SIZE` and wraps JSON parse errors with a response preview
- `ffmpeg.ts` — `checkFfmpeg()`, `runFfmpeg()`, `getDuration()`, `getVideoSize()`, `extractAudio()`: subprocess wrappers with install-hint errors when ffmpeg/ffprobe are absent
- `srt.ts` — pure functions for generating SRT and ASS subtitle files from Whisper word timestamps; no I/O or external dependencies
- `output.ts` — `saveMedia()` (atomic write with path traversal guard), `downloadAndSave()` (SSRF-safe URL validation + size limit), `formatBytes()`, `formatDuration()`

> E2E verification requirements live in the flow graph — see flow skills via `npx agent-core search "flow/" --type skill`
