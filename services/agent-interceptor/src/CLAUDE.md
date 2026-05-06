# src

Core source for the agent-interceptor service. The `app.ts` file builds the Hono application with all routes; `config.ts` parses environment variables into `InterceptorConfig`; `contract.ts` defines the stable `WebhookEvent` boundary type; `types.ts` exports shared types (`NormalizedWebhook`, `WebhookNormalizer`, `InterceptorConfig`, `GatewayRuntime`). Subdirectories cover specific concerns: entrypoints, normalizers, poll, proxy, and store.

> E2E verification requirements live in the flow graph — see flow skills via `npx agent-core search "flow/" --type skill`
