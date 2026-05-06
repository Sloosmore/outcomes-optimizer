# agent-livestream/server/adapters/research

SSH-backed research adapter that runs research.mjs inside the user's per-user
sandbox. Both chat and voice paths funnel through the same runner: tools.ts
(chat) and tools/research-tool.ts (voice) call `runSandboxAgent`, which uses
the SSH manager to upload+exec the research script in the sandbox VM.

- `sandbox-agent-runner.ts` — Single research entry point; SSHes into the
  user's sandbox and runs research.mjs there. Returns `{ text }`.
- `ssh-manager.ts` — SSH connection multiplexer; manages persistent SSH
  control sockets.
- `types.ts` — Shared interface types for the research adapter contract.
- `ssh-manager.test.ts` — Unit test coverage.

The sandbox owns artifact generation, port allocation, and HTTP serving. The
BFF is a thin SSH bridge — it does not build HTML, pick ports, or render.
