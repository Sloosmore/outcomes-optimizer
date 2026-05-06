# sandbox

Provider abstraction for Hetzner VM lifecycle: provision, poll status, deprovision. Used by `duoidal-cli` as the infrastructure layer for `sandbox provision` and `sandbox deprovision` commands.

Two implementations: `HetznerProvider` (real API calls to `api.hetzner.cloud/v1`) and `MockSandboxProvider` (in-memory, used in tests and when `SANDBOX_PROVIDER=mock` or `NODE_ENV=test`).

> E2E verification requirements live in the flow graph — see flow skills via `npx agent-core search "flow/" --type skill`
