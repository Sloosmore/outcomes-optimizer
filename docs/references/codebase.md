# Codebase Reference — Foot Guns, Architecture Rules, E2E Philosophy

This document captures hard-won lessons about this codebase. Loop agents, reviewers, and new contributors should read it before touching shared infrastructure. It is not aspirational — every entry here came from something that broke.

---

## Architecture: Where Things Live

### The four zones

| Zone | Purpose | Rule |
|------|---------|------|
| `utils/` | Pure loop infrastructure — epoch orchestrator, run harness, database schema, config loading, shared types | Nothing here starts a server, exposes HTTP, or has a deployment lifecycle |
| `services/` | Deployed processes with their own lifecycle — credential proxy, agent interceptor, sidecar, logger | If it has a `main()`, binds a port, or gets deployed independently, it lives here |
| `packages/` | CLI tools consumed by agents — agent-media, agent-email, agent-browser, agent-core | Agent-facing interfaces; must work without knowing which infrastructure surrounds them |
| `skills/` | Version-controlled agent capabilities | Prompt artifacts, not code; evolve through execution |

### The separation test

Ask: *if you deleted this component, would any other component need to change its source code?*

- If **yes** → it is coupled too tightly. The interface is wrong.
- If **no** → the boundary is correct.

A package should never import from a service. A service should never import from `utils/` in a way that creates deployment coupling. `utils/database/` is the one shared exception — it is infrastructure, not a service.

### Known violations to fix (do not replicate)

- `utils/logger/` — logger was built in `utils/` before `packages/logger/` existed. Being removed. Use `@skill-networks/logger` from `packages/logger/`.
- Any file in `utils/` that calls `createServer()` or `listen()` — move it to `services/`.

---

## Known Foot Guns

### 1. `CLAUDECODE=1` blocks nested headless sessions

The Claude Code CLI sets `CLAUDECODE=1` in its environment. If a loop launch script inherits this, nested `claude -p` invocations fail silently or hang.

**Fix**: `unset CLAUDECODE` in launch scripts before spawning the loop.

### 2. Hardcoded ports cause conflicts on shared servers

When multiple worktrees run on the same machine (common in tmux-based local runs), hardcoded ports collide. The second instance fails to bind and exits immediately.

**Fix**: Always use port `0` (OS assigns a free port). Parse the assigned port from the process's own stdout before using it downstream. See `services/sidecar/index.ts` for the pattern.

### 3. `validateEnvironment()` throws outside GitHub Actions

`utils/cli/adapters/claude-code/index.ts` calls `validateEnvironment()` which checks for `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`. It throws if neither is set — but locally, credentials come from stored Claude auth, not an API key.

**Fix**: The throw is gated on `GITHUB_ACTIONS === 'true' || CI === 'true'`. Do not remove that gate.

### 4. Loop runs from the worktree, not the main repo

The launch script must invoke `utils/loop/index.ts` from the **main repo path** (`$REPO_ROOT/utils/loop/index.ts`) but run it with `cwd` set to the worktree. This ensures patched loop code in a worktree takes effect, while the main repo's loop orchestrates it.

### 5. `kill %1 %2` does not work across shell invocations

Shell job control (`%1`, `%2`) is session-local. If an agent starts a background process in one Bash call and tries to kill it in a separate call, `%1` is undefined.

**Fix**: Capture PIDs explicitly (`SIDECAR_PID=$!`) immediately after backgrounding, and kill by PID.

### 6. Doppler project scope for credential resolution

The credential proxy resolves secrets from a single Doppler project (set via `DOPPLER_PROJECT` / `DOPPLER_CONFIG`). All third-party tokens (e.g. `INSTAGRAM_*`) must live under that same project/config. When running the proxy locally for E2E tests, point `DOPPLER_PROJECT` at the same project the deployed proxy uses and use a CLI personal token (`dp.ct.*`), not a service token.

### 7. `socks5h://` proxy URLs bypass the SSRF guard

The credential proxy explicitly rejects `socks5h://` — it delegates DNS to the proxy server, bypassing local SSRF protection. Use `socks5://` or `socks4://` instead.

---

## E2E Test Philosophy

Unit tests confirm the code does what you wrote. E2E tests confirm the real system accepted it.

**The single test to apply to every criterion**: *if the real system silently rejected this, would this check catch it?* If no — it is not a verification, it is an observation.

### What a real E2E test looks like

A real E2E test:
- Starts actual processes (`npx tsx services/sidecar/index.ts &`)
- Calls real CLI commands (`npx agent-core resource add`, `curl`, `gh`)
- Writes to the real database and reads back
- Checks stdout/stderr of real processes for expected output
- Kills processes it started, checks exit codes

A real E2E test does **not**:
- Mock the database, network, or filesystem
- Assert that a function returned the right value
- Confirm a file was written without reading its contents
- Use `sleep` as a substitute for readiness checks (use log polling instead)

### The verification layers

Every goal needs all three:

1. **Live end-to-end (1–2)**: the real system, nothing simulated. This is the check the real system can fail — the one that catches what no local test reveals. Example: `curl` through the sidecar to the real Instagram API and confirm HTTP 200 + `x-credential-injected: true` in the response.

2. **Boundary verifications (one per handoff)**: each confirms a specific interface accepted input and produced expected output. Example: credential proxy stdout contains `[proxy] resource=X process=Y injected=true` — confirms the header crossed the sidecar→proxy boundary correctly.

3. **Edge case / rejection verifications**: failure modes. Simulation is acceptable here. Example: `PROCESS_ID` missing → process exits 1 with the right error message.

### Integration test files vs shell E2E

`*.integration.test.ts` files run inside vitest and are good for database round-trips and API boundary checks. But they are not a substitute for shell-level E2E. The goal is to have both:

- `vitest` integration tests: confirm the library API works against a real DB
- Shell E2E scripts: confirm the deployed/running process behaves end-to-end

If a success criterion can only be verified by running a process and inspecting its output — write a shell script, not a vitest test. The loop agent should `tee` output to `workspace/e2e/<slug>.txt` so oversight can verify it.

---

## Loose Coupling Checklist

Before opening a PR, confirm:

- [ ] No package imports from a service
- [ ] No service imports from another service directly (use HTTP or shared `@skill-networks/*` packages)
- [ ] No hardcoded ports
- [ ] No hardcoded credential values or env var names outside `services/credential-proxy/src/index.ts`
- [ ] New processes that start servers live in `services/`, not `utils/` or `packages/`
- [ ] Kill signals are handled (`SIGTERM`, `SIGINT`) in any new server
- [ ] Dynamic port assignment with stdout reporting for any new sidecar/service started by the launch script
