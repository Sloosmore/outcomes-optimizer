# src/proxy

The proxy resolver (`resolve.ts`) that looks up a `proxy`-typed resource link in the database for a given `data.resource` name and returns an undici `ProxyAgent` for outbound requests. Used in the `/hooks/agent` endpoint to route sub-agent dispatches through the correct credential proxy.

> E2E verification requirements live in the flow graph — see flow skills via `npx agent-core search "flow/" --type skill`
