# agent-instagram/src/commands

Command implementations for the agent-instagram CLI:
- `login.ts` — authenticate and persist session to `~/.agent-instagram/session.json`
- `post.ts` — post photo, video, or reel via the Graph API
- `profile.ts` — read profile info
- `profile-set.ts` — write profile fields (bio, name, website, pic) via instagrapi with immediate read-back verification
- `status.ts` — check the processing status of a media container
- `analytics.ts` — fetch reach, views, saves, likes, comments, shares for a published post

All commands load session state from disk (or env vars for profile-set), call the appropriate session method, and print results in human-readable or JSON format.

> E2E verification requirements live in the flow graph — see flow skills via `npx agent-core search "flow/" --type skill`
