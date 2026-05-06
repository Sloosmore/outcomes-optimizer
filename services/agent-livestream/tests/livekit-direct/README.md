# LiveKit direct harness

Bypasses the Vercel UI to verify the voice-agent → BFF → sandbox SSH path.

## Prereqs

- Local BFF running on `:3001` (`pnpm exec tsx server/adapters/node.ts` from the agent-livestream root, with Doppler env)
- Local agent worker connected to LiveKit Cloud (`pnpm exec tsx server/voice-agent.ts dev`, with Doppler env + `BFF_URL=http://localhost:3001`)
- The acting user must have a canonical sandbox row (server resource) with: parent link → user, `config.ip`, and a credential link → SSH-key credential whose `config.vaultSecretId` resolves to a private key in Supabase Vault

## Run

```bash
doppler run --project <your-project> --config <your-config> -- \
  pnpm exec tsx tests/livekit-direct/harness.mts \
    --user-id <auth_user_id> \
    --prompt "research the codebase architecture in /root/repos/outcomes-optimizer"
```

The harness:
1. Mints a `voiceToolJwt` for the user
2. Creates `room-<uuid>` with the JWT in metadata
3. Dispatches `voice-agent` into the room
4. Joins as a tester participant
5. Sends the prompt over the `lk.chat` text-stream topic
6. Logs every text-stream + data event the agent emits

## Expected

- `[harness] room metadata length=303` (JWT carried)
- Agent log: `research tool called` → `sandbox ctx resolved {ok: true, host, sandboxId}` → `starting runSandboxAgent` → `research complete`
- Agent's text reply contains an `artifact-<sandboxId>-<port>.example.com` URL
- A subsequent `share_screen` tool call from the agent (verified via `[data] topic=...` lines or follow-up text)
