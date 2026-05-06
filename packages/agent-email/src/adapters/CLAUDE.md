# agent-email/src/adapters

Defines the `EmailAdapter` / `EmailSession` interfaces and implements three adapters: `MailTmAdapter` (private disposable email, auth required), `OneSecMailAdapter` (public disposable, no auth), and `GmailAdapter` (real Gmail via OAuth2). The `AdapterRegistry` singleton holds all registered adapters and is populated at module load time in `index.ts`.

> E2E verification requirements live in the flow graph — see flow skills via `npx agent-core search "flow/" --type skill`
