# agent-instagram/src/adapters

Adapter layer for Instagram. Defines the `InstagramAdapter` and `InstagramSession` interfaces (`types.ts`), implements two concrete adapters (`instagram-api.ts` for Graph API posts/reads, `instagrapi/` for profile writes via Python), and exports a singleton `AdapterRegistry` (`registry.ts`) that maps adapter names to instances.

Two adapters are registered at startup via `index.ts`:
- `instagram-api` (default): uses the Instagram Graph API for posting and reading
- `instagrapi`: uses a Python subprocess for profile write operations (set bio, name, website, profile picture)

> E2E verification requirements live in the flow graph — see flow skills via `npx agent-core search "flow/" --type skill`
