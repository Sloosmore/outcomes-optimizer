# agent-interceptor/e2e

End-to-end test that verifies the agent-interceptor service writes a startup log entry to the database. Spawns the real Node.js entrypoint as a subprocess, polls `/health` until the server is live, then queries the `logs` table to confirm a row was written.

> E2E verification requirements live in the flow graph — see flow skills via `npx agent-core search "flow/" --type skill`
