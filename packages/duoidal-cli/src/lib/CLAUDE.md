# duoidal-cli/src/lib

Shared utilities used across all commands.

- `config.ts` — token file I/O (`readToken`, `writeToken`), sandbox key storage (`writeSandboxKey`, `getSandboxKeyPath`), `CONFIG_DIR` (`~/.config/duoidal/`)
- `require-auth.ts` — `requireAuth()`: reads stored token or `DUOIDAL_TOKEN` env var, validates sub claim and expiry, exits with error if unauthenticated
- `helpers.ts` — `loadExecuteAction()`, `getSupabaseUrl()`, `getSupabaseAnonKey()`, `getApiBaseUrl()`. **All Supabase URL/key access must go through these helpers** — they read from env and throw if unset. Never read `process.env['SUPABASE_URL']` or `process.env['SUPABASE_ANON_KEY']` directly in commands.
- `sandbox-meta.ts` — `readSandboxMeta`, `writeSandboxMeta`, `findSandboxResourceIdByName`: local meta file management for sandbox state. **SUPERSEDED** — new code should use `@duoidal/config` (from `packages/duoidal-config`) instead; this file is retained for backward-compatibility only
- `sandbox-bff-client.ts` — `getRepoCloneUrl(jwt, repo)`, `sandboxBffClient`: BFF API client for all privileged sandbox operations (GitHub token minting, etc.). All server-secret-dependent calls go here; the CLI never reads server secrets directly
- `sandbox-actions.ts` — sandbox-specific action helpers
- `cli-installer.ts` — `NpmCliInstaller` and `LocalCliInstaller`: install duoidal CLI on a remote sandbox via SSH

**Server state module**: `@duoidal/config` (from `packages/duoidal-config`) is the current module for reading and writing server/sandbox state. Resolution order: `$DUOIDAL_CONFIG` env → `.duoidal/config.json` (CWD) → `~/.duoidal/config.json` → auto-create.

> E2E verification requirements live in the flow graph — see flow skills via `npx agent-core search "flow/" --type skill`
