# agent-youtube/src/adapters

YouTube API adapter — session-based pattern: stateless factory + stateful session.

- `types.ts` — `YouTubeAdapter` (factory), `YouTubeSession` (connection), and supporting types (`ChannelInfo`, `VideoUpload`, `UploadResult`, `VideoMetrics`, etc.)
- `youtube.ts` — `YouTubeAdapterImpl` + `YouTubeSessionImpl`: real googleapis client; patches `globalThis.fetch` with `duplex: 'half'` for Node.js 22 streaming compatibility and routes all googleapis calls through `globalThis.fetch` so the credential-proxy interceptor can inject tokens transparently
- `oauth.ts` — OAuth2 flow: `runOAuthFlow` (device code / browser redirect) and `createOAuth2Client`
- `registry.ts` — adapter registry: singleton registry for adapter instances
- `token-exchange.ts` — token refresh helpers

> E2E verification requirements live in the flow graph — see flow skills via `npx agent-core search "flow/" --type skill`
