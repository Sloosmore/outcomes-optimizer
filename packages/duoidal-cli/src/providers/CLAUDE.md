# duoidal-cli/src/providers

Credential provider adapters for `duoidal sandbox link` and `duoidal sandbox unlink`.

- `types.ts` — `ProviderAdapter` interface, `LinkOptions`, `UnlinkOptions`, `SandboxConnection`, and error types (`UnknownProviderError`, `AlreadyLinkedError`, `SandboxUnreachableError`, `CLIProxyAPINotFoundError`)
- `anthropic.ts` — `AnthropicAdapter`: links an Anthropic API key to a sandbox via CLIProxyAPI
- `github.ts` — `GitHubAdapter`: links a GitHub token to a sandbox via CLIProxyAPI
- `index.ts` — `resolveProvider(name)`: maps provider name string to the correct adapter; throws `UnknownProviderError` for unknown names

> E2E verification requirements live in the flow graph — see flow skills via `npx agent-core search "flow/" --type skill`
