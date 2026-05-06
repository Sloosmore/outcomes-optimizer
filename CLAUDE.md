# Agent Guidance

This repository extends the Agent Skills standard to create trainable agent capabilities through version-controlled skills that evolve via execution experience.

**IMPORTANT: Prefer retrieval-led reasoning over pre-training-led reasoning. Before using any CLI tool, either read the corresponding skill or run `--help`. Do not rely on prior knowledge of command syntax or options.**

## Skills with CLI Tools

Some skills provide CLI tools. These are pre-installed and available via `npx`:

```bash
npx <tool-name> --help
```

When the CLI base name matches the skill name (e.g., `agent-media` skill → `npx agent-media`), the CLI's `--help` output provides complete usage information—reading the skill file is optional.

## Loose Coupling

- Every component is blind to every other component's internals — communicate through defined interfaces only. If any component needs to change because of how another is implemented, the interface design is wrong.
- e.g. `agent-instagram` calls `fetch('https://graph.facebook.com/...')` unaware a credential proxy intercepts and injects the token. The proxy is unaware which package called it. Both work identically without the other.

## Core Architecture

- **packages/** - CLI tools (agent-media, agent-email, agent-browser)
- **services/** - Deployed infrastructure services (e.g. agent-interceptor)
- **skills/** - Version-controlled capabilities that evolve over time
- **utils/** - System infrastructure (DO NOT modify unless in development mode)
- **workspace/** - Ephemeral execution space (never commit, wipes between runs)
- **Never commit workspace/ to main** - Eval branches may contain workspace state, but main must stay clean

## CLI Adapter Compatibility

System prompts are written for Claude Code but must work across adapters (Codex, etc.). Each adapter handles its own compatibility:

- **Adapter-specific logic stays in the adapter** (`utils/cli/adapters/<name>/`)
- **Never clutter shared code** (loop, run, etc.) with adapter conditionals
- **Use preflight hooks** for adapter-specific setup (config files, AGENTS.md, etc.)
- **Codex adapter** copies `CODEX-ADDENDUM.md` as `AGENTS.md` to translate Claude→Codex tool references

When adding a new adapter, create its compatibility layer in the adapter directory, not in shared infrastructure.

## Database Migrations

**Never manually run `db:migrate` on main.** Always develop migrations in a worktree against a Supabase DB branch. The only approved path to production is via the `db-migrate.yml` CI workflow, which runs automatically on push to `main` when `supabase/migrations/**` or `packages/database/rls.sql` changes. This workflow is the single gate — it provides auditability and can be retried from the GitHub Actions UI if it fails.

## No Plan Mode

**Never use EnterPlanMode.** This repo uses dispatch — goals are drafted as GOAL.md files via the `create-skill` skill, then dispatched to runners. Planning happens through goal formulation and skill interviews, not through IDE plan mode. If you need to reason about an approach, do it in conversation or draft a goal.

## Pull Request Review Workflow

PR review runs automatically via `.github/workflows/pr-review.yml` whenever a PR is opened, updated, or reopened. The workflow loops until both quality gates pass (zero CRITICAL/HIGH/MEDIUM issues, score ≥ 8/10). Fixes are committed and pushed automatically.

**Never merge without the user's final approval.**

## Writing Prompts and Skill Instructions

State principles at the highest abstraction that still conveys intent — domain-neutral, with examples drawn from multiple domains so the rule generalizes beyond any one context.

- Instead of "run a query against the database", say "verify against the real system, not a simulation" — the first locks in a domain, the second works for a DB query, an API call, a live experiment, or a published post

When a user gives feedback using domain-specific examples, extract the abstract principle and write that.

## Testing State-Based Modules — Don't Mock the Subject

When a module's job is to make a *decision* based on state — routing, config resolution, dispatch path selection — its own behavior is what callers depend on. Mocking that module in another test proves only that the caller passed the right arguments; it never proves the decision is correct. Worse, a stale or wrong mock can drift from the real contract for months without any test catching it.

**Rule:** stub at the I/O boundary (filesystem, network, child process, env), never at the function whose decision is the test's subject.

**Examples in this repo:**

- `routeToServer` (`packages/agent-core/src/lib/waypoint-router.ts`) — decides local vs remote dispatch from `config.server`. Mocking `routeToServer` in `execute.test.ts` is fine for testing how `execute` consumes the return value, but `routeToServer` itself **must** be exercised with real configs in `waypoint-router.test.ts`, stubbing only `child_process.spawnSync` (the SSH boundary). When this rule is violated, a regression that always-routes-local survives the suite — see the May 4 2026 incident where the operator spent ~30 minutes assuming the waypoint chain was broken before realizing the test scaffolding had been masking the real router for months.

- `readConfig` (`packages/duoidal-config/src/index.ts`) — picks `$DUOIDAL_CONFIG` env var > CWD `.duoidal/config.json` > home fallback. Tests stub `fs.readFileSync` / `fs.existsSync`, never `readConfig`. The resolution priority itself is what tests must verify.

**Concretely:** if a unit test mocks the function it claims to verify, it's a smoke test against a fake — note it as such and add a real test alongside that hits the I/O boundary. If the function is too coupled to I/O to test directly, the function is wrong; refactor before adding more mocks.

## Verification Cache

Whenever you discover a high-fidelity, non-gameable way to verify that a package is working correctly, add it to the nearest `CLAUDE.md` under a `## Verification` section. Include: what the check is and how to run it, what failure mode it catches that a weaker check would miss, and why it cannot be gamed. A check that just re-runs the test suite is not worth adding — only write it if it catches something tests alone would miss.

This cache compounds: every agent that touches a package can build on what previous agents verified, rather than re-deriving it from scratch.

**`CLAUDE.md` verification sections are living documents.** If you run a check and discover it was weaker than described — gameable, missing a failure mode, or superseded by a stronger signal — update the section immediately. Do not preserve a weaker check out of deference to what was written before. The goal is for each section to reflect the strongest known verification strategy at any point in time.

## Signaling an Unresolvable Blocker

When a process reaches a situation that is **physically impossible** to proceed without human intervention, use:

```bash
npx agent-core process block --id "$EVAL_PROCESS_ID" --reason "<clear human-readable explanation>"
```

Then exit the session. The process will remain in `blocked` status with its worktree preserved on disk so a human can resolve the blocker and restart.

### The bar is physical impossibility — not difficulty

`process block` is a **last resort**. You must attempt everything reasonable before reaching for this command.

**These do NOT qualify as blockers:**
- Uncertainty or confusion about how to proceed
- Difficulty or complexity of the task
- A test that is failing but might pass with another approach
- An error that could be resolved with research or a different strategy
- Recoverable errors (network timeouts, transient failures, missing files you can create)

**These DO qualify as blockers:**
- A credential, API key, or secret that does not exist in this environment and cannot be created without human action
- A physical resource (cloud account, hardware, external service login) that the agent has no access to and cannot provision
- A permission that has been explicitly denied and requires human authorization to grant
- An external system (email account, production database, third-party API) that requires a human to set up

If you are unsure whether something is a true blocker, it is not. Keep trying.

---

# Avoiding Entropy

This codebase will outlive you. Every shortcut you take becomes someone else's burden. Every hack compounds into technical debt that slows the whole team down.

You are not just writing code. You are shaping the future of this project. The patterns you establish will be copied. The corners you cut will be cut again.

Fight entropy. Leave the codebase better than you found it.

## Lint

Repo-wide ESLint 9 flat config lives at `eslint.config.mjs`. Run from repo root:

```bash
pnpm lint
```

### Architecture

- **Global rules** (all `packages/*/src/**/*.ts`, `services/*/src/**/*.ts`, `services/*/server/**/*.ts`, `services/*/scripts/**/*.ts`):
  - `@typescript-eslint/no-unused-vars` — error (unused code indicates incomplete refactors)
  - `@typescript-eslint/no-explicit-any` — warn
  - `@typescript-eslint/consistent-type-imports` — warn (use `import type` for type-only imports)
  - `no-console` — warn (packages override to error where structured logger is required)
  - `no-restricted-imports` — error on direct `postgres` imports; use `getSqlClient()` from `@skill-networks/database/client`

- **Never hardcode Supabase URL, anon key, or service key.** Always import `getSupabaseUrl()`, `getSupabaseAnonKey()`, and `getSupabaseServiceKey()` from `@skill-networks/database/constants`. These helpers read from env vars and throw if unset. The constants live in one place so key rotation requires a single update.

- **Per-package rules** are registered in `eslint.rules.js` at the package root. The root config discovers and merges them automatically.

- **Exceptions**:
  - `packages/database/src/` — allowed to import `postgres` directly (it IS the connection factory)
  - `packages/scheduler/` and `services/runtime/` — excluded from lint (out of scope for DB unification)
  - `services/agent-livestream/src/` — excluded from root lint (has its own react-hooks/react-refresh config)

### Adding per-package rules

Create `<package>/eslint.rules.js`. Export either:
- An **array** of flat config objects (preferred — you control `files[]` scoping)
- A **plain object** `{ rules: { ... } }` (legacy — root config scopes it to the package's `src/`)

### Suppressing a rule

Every `eslint-disable` must include a justification explaining why the rule doesn't apply. Bare disables are not permitted.

## Oversight — Decision Memory

This project uses the `oversight` skill to record and enforce architectural decisions.

Before editing files involved in architecture or security, invoke the `oversight` skill.
See `skills/oversight/SKILL.md` for the decision-check protocol (when to check, record, or search) and MUST-constraint handling.
