# duoidal-cli/src/commands

Subcommand implementations for the `duoidal` CLI.

- `sandbox.ts` — `sandboxCommand`: provision, deprovision, status, ssh, link, unlink. Owns the full VM lifecycle: keygen → Hetzner provision → DB update → SSH wait → Node.js install → CLI install
- `auth.ts` — login (browser OAuth + access-code path), logout, whoami
- `repo.ts` — `repoCommand`: clone/sync repo to sandbox
- `github.ts` — `githubCommand`: GitHub integration (clone with token)
- `process.ts` — `processCommand`: show/block/list processes via agent-core CLI calls
- `credential.ts` — `linkCommand` / `unlinkCommand`: link/unlink provider credentials to a sandbox
- `config.ts` — `configCommand`: `duoidal config migrate` — one-time migration from `~/.config/duoidal/sandboxes/*/meta.json` to `~/.duoidal/config.json`

> E2E verification requirements live in the flow graph — see flow skills via `npx agent-core search "flow/" --type skill`
