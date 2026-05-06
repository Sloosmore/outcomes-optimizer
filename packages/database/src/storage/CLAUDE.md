# database/src/storage

Object storage adapter layer. `StorageContract` defines the interface (upload, download, list); `supabase.ts` implements it for Supabase Storage. `index.ts` re-exports both.

Consumers (publish script, BFF skills route) import from `@skill-networks/database/storage` — never from Supabase directly. Future adapters (S3, GCS) implement `StorageContract` and drop into this folder.

> E2E verification requirements live in the flow graph — see flow skills via `npx agent-core search "flow/" --type skill`
