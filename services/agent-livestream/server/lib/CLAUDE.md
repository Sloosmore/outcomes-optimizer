# agent-livestream/server/lib

Infrastructure wiring for the agent-livestream BFF server:

- `services.ts` — Singleton factory that initializes all DB service instances (ResourcesService, MetricsService, ProcessesService, EventsService, MessagesService, ChatsService, EpochResultsService)
- `supabase.ts` — Creates the Supabase admin client used for auth and DB operations outside the ORM
- `artifact-parser.ts` (in `server/`) — Constructs and resolves artifact URLs via `buildSandboxArtifactUrl` / `resolveArtifactUrl`; canonical format is `artifact-{sandboxId}-{port}.example.com`

> E2E verification requirements live in the flow graph — see flow skills via `npx agent-core search "flow/" --type skill`
