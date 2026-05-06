# agent-youtube/src/commands

CLI subcommand implementations.

- `upload.ts` — upload a video file to YouTube; returns video ID on success
- `list.ts` — list uploaded videos (with optional limit)
- `delete.ts` — delete a video by ID
- `metrics.ts` — fetch view/like/comment counts for a video
- `quota.ts` — show daily API quota usage and remaining budget
- `transcript.ts` — fetch auto-generated or manual transcript for a video
- `whoami.ts` — verify auth and show channel info

> E2E verification requirements live in the flow graph — see flow skills via `npx agent-core search "flow/" --type skill`
