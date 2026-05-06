# agent-livestream/tests/setup

Test fixture generation scripts for the agent-livestream Playwright suite.

- `generate-fixtures.ts` — calls OpenAI TTS to produce PCM16 audio files used by voice E2E tests. Writes to `tests/fixtures/voice-{a,b}-turn-{1-5}.pcm16`.

Run this script once (or when voice test scripts change) to regenerate the fixture files before running the Playwright voice test suite.

```bash
cd services/agent-livestream
OPENAI_API_KEY=<key> npx tsx tests/setup/generate-fixtures.ts
# Writes 10 PCM16 fixture files to tests/fixtures/
```

> E2E verification requirements live in the flow graph — see flow skills via `npx agent-core search "flow/" --type skill`
