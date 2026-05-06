# sandbox/src

Core implementation files for the `@duoidal/sandbox` package.

- `provider.ts` — `SandboxProvider` interface and supporting types (`ProvisionOptions`, `ProvisionResult`, `ServerStatus`, `ServerStatusResult`)
- `hetzner.ts` — `HetznerProvider`: real Hetzner Cloud API client (provision, getStatus, deprovision)
- `mock.ts` — `MockSandboxProvider`: in-memory test double; activated when `NODE_ENV=test` or `SANDBOX_PROVIDER=mock`
- `index.ts` — `createSandboxProvider()` factory that selects the correct provider from environment

> E2E verification requirements live in the flow graph — see flow skills via `npx agent-core search "flow/" --type skill`
