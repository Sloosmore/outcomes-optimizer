# src/normalizers

Platform-specific normalizer functions that convert raw webhook payloads into the shared `NormalizedWebhook` shape. Currently: `github.ts` (handles `workflow_run`, `push`, `pull_request`, `issue`, `issue_comment`, and unknown GitHub events) and `instagram.ts` (handles Instagram Graph API webhook deliveries, processing only the first entry).

> E2E verification requirements live in the flow graph — see flow skills via `npx agent-core search "flow/" --type skill`
