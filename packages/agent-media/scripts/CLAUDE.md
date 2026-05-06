# agent-media/scripts

Quality-assurance scripts for agent-media.

`verify-pipeline.ts` — end-to-end caption/assemble pipeline check. Downloads three CC0 public-domain video clips with clear human speech, runs `agent-media caption` on each (Whisper transcription + ffmpeg subtitle burn), then runs `agent-media read --review` on the captioned output and asserts that Gemini scores the result as `"post"` or `"edit"` (not `"regenerate"`) and that Whisper returned at least one word.

```bash
npx tsx packages/agent-media/scripts/verify-pipeline.ts --output-dir workspace/verify
# Exit 0: all three clips passed
# Exit 1: one or more clips failed — see workspace/verify/report.json
```

> E2E verification requirements live in the flow graph — see flow skills via `npx agent-core search "flow/" --type skill`
