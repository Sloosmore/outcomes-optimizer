# Roadmap

*Last reviewed: 2026-03-11*

## Phase 1: Core Infrastructure ✅

*Completed 2026-01-21*

### Config System ✅
YAML config driving CLI selection and database mode.

```yaml
experiment:
  name: first-test
database:
  adapter: none        # none | local | cloud
cli:
  adapter: claude-code # claude-code | codex | mock
```

### CLI Service Layer ✅
Abstraction for different CLI tools (Claude Code, Codex, mock).

| Adapter | Config Dir | Skills Dir | Preflight |
|---------|------------|------------|-----------|
| `claude-code` | `.claude/` | `.claude/skills/` | Writes agents to `.claude/agents/` |
| `codex` | `.codex/` | `.agents/skills/` | Headless config + AGENTS.md |
| `mock` | `.mock/` | `.mock/skills/` | Mirrors claude-code for testing |

Each adapter is now a folder with `index.ts` + `preflight.ts`:
```
utils/cli/adapters/
├── claude-code/
│   ├── index.ts      # Adapter implementation
│   └── preflight.ts  # eval-agent hook
├── codex/
└── mock/
```

### Skill Sync ✅
Copy skills from `skills/` to CLI target directory.

### GitHub Actions Workflow ✅
Headless execution with caching for node_modules and Playwright browsers.

### First Skill ✅
`agent-browser` skill from vercel-labs successfully syncs and executes.

---

## Phase 2: Agent Tool CLIs

### agent-email ✅
CLI for managing email inboxes in agent workflows.

```bash
agent-email init                    # Create inbox
agent-email wait --from "noreply"   # Wait for verification email
agent-email extract-link            # Get verification link
```

- Session-based adapter pattern
- 1secmail adapter (MVP)
- State in `~/.agent-email/`

### agent-media 🔄
CLI for generating media (images, video, audio).

```bash
agent-media image "prompt" --output hero.png
agent-media video "prompt" --output clip.mp4
agent-media audio "text" --output intro.mp3
```

- Multi-registry pattern (one registry per modality)
- Gemini for images/video, OpenAI for audio
- Cost estimation with `--dry-run`
- Capability discovery via `getCapabilities()`

**Status:** Design complete, ready for implementation

### dispatch ✅
Skill for interviewing the user and launching the optimization loop.

---

## Phase 3: Validation Framework

### Substack E2E Test 🎯
Target validation: Agent creates Substack account, generates images, publishes post.

**Required components:**
- [x] agent-browser (exists)
- [x] agent-email (built)
- [ ] agent-media (design ready)
- [ ] Eval injection mechanism
- [ ] Prompt modules (survey, decompose, execute)

### Stray File Lint 📋
Pre-commit check that validates staged files against allowlist.

```yaml
# config.yaml
allowedPaths:
  - skills/**
  - packages/**
  - utils/**
  - docs/**
```

Prevents committing files outside expected structure.

**Status:** Planned

### Eval Injection 📋
Runtime mechanism to drop skills/evals into sandbox for testing.

```bash
# Copy test skills to CLI working dir
# (planned — no tool yet)
```

**Status:** Planned

---

## Phase 4: Data & Persistence

### Database Adapters
- [ ] SQLite adapter (`database.adapter: local`)
- [ ] PostgreSQL adapter (`database.adapter: cloud`)
- [ ] Post-commit hook uses SkillService

### Skills Linter
- [x] Frontmatter validation
- [x] Import validation
- [ ] Backmatter validation

### Backmatter Completion Check
- [ ] Parse completion criteria from SKILL.md
- [ ] Evaluate criteria after execution
- [ ] Report COMPLETE/INCOMPLETE

### Pre-commit Hook Integration
- [x] Run linter before commit
- [x] Validate JSONL changelog
- [ ] Stray file lint

### Post-commit Hook
- [ ] Record skill versions in database
- [ ] Extract imports from frontmatter

---

## Phase 5: Skill Ecosystem

### Seed Skills
- [ ] Pull from Vercel registry
- [ ] Pull from GitHub
- [ ] Pull from local directory

### Skill Discovery
- [ ] Generate dependency graph
- [ ] Index available skills

---

## Phase 6: Eval System

### Preflight Hooks ✅
Adapter-specific setup that runs before CLI invocation.

```typescript
// Each adapter has preflight.ts
target.registerPreflight(evalAgentHook)
await runPreflight(target)  // Writes agent definitions
```

- Hooks write to adapter's configDir (.claude/, .codex/, etc.)
- Error handling with PreflightError class
- Context frozen to prevent mutation between hooks
- Deduplication prevents double registration

**Status:** Complete

### Eval Agent ✅ (Claude Code)
Sub-agent for evaluating skill executions against rubric criteria.

- Written to `.claude/agents/eval-agent.md` via preflight hook
- "Everything is a file" pattern - all artifacts passed as files
- Natural language criteria interpreted by model
- Structured JSON output with pass/fail per check

**Status:** Complete for Claude Code; Codex runs without subagents

### Skill evals/ Folder (Optional Future)
Pre-written verification code for deterministic checks.

```
skills/my-skill/
├── SKILL.md
└── evals/                    # OPTIONAL
    ├── config.yaml           # Which checks use code vs interpretation
    └── verifiers/
        ├── api-response.ts   # Deterministic: status codes, field presence
        └── id-consistency.ts # Cross-artifact correlation
```

**When to use:**
- Arithmetic/financial calculations (eliminates rounding variance)
- Cross-artifact ID correlation (field name normalization)
- Edge cases needing explicit rules (queued vs created)

**When to skip:**
- Simple pass/fail checks (HTTP 200)
- Visual/semantic judgment (page looks correct)
- One-off checks not worth codifying

**Status:** Designed, not yet implemented. Natural language eval works without it.

---

## Phase 7: Loop Architecture Evolution

### PRD Structure: Sequential → DAG

**Current**: Stories execute sequentially (1 → 2 → 3)

**Future**: Stories form a dependency graph with parallelizable layers

```
Layer 1 (parallel):   [Story 1]  [Story 2]  [Story 4]
                          │          │          │
                          └────┬─────┘          │
                               ▼                │
Layer 2:                   [Story 3]            │
                               │                │
                               └───────┬────────┘
                                       ▼
Layer 3:                           [Story 5]
```

**Key insight**: The `depends_on` field already exists. The shift is using it to express true dependency structure rather than forcing artificial sequencing.

**Layer computation**:
- Layer N = all stories whose dependencies are satisfied by Layers 0..N-1
- Edge nodes (Layer 1) have `depends_on: []`
- Each layer can execute in parallel

**Execution model**:
- The **leader agent** orchestrates each layer's execution
- For a given layer, the leader identifies all edge nodes (stories with satisfied dependencies)
- Edge nodes within a layer can be assigned to parallel workers (or agent teams in the future)
- The leader waits for layer completion before advancing to the next layer
- State updates are coordinated through the leader to maintain consistency

### Feature Interaction Coverage ✅

PRDs now require explicit `feature_interactions` field:

```json
"feature_interactions": {
  "modifies": ["features this PRD changes"],
  "related": ["features that could be affected"],
  "interaction_matrix": [
    { "features": ["A", "B"], "tested": true, "coverage": "story_id", "notes": "" }
  ]
}
```

**Principle**: "Deferred is acceptable, silence is not" - every feature combination must be explicitly addressed.

**Status**: Implemented in `skills/oversight/references/generator.md` and `prd-validator.md`

### Test Set Expansion 📋

Expand from ~40 slides to 80 with **combinatorial coverage**:
- Feature A × Feature B × Source (slide/layout/master)
- Catches integration bugs that isolated tests miss

**Status**: Plan in progress

### Future: Agent Teams Integration

*Noted for future work - keeping stable for now*

When agent teams are available, each layer's edge nodes can execute in parallel with dedicated agents. The PRD becomes the coordination plan.

### Future: Agent Work Plan File Format

Custom file format (`.plan` or similar) for agent work plans as versioned dependency graphs:

- Stories as nodes in a DAG with explicit dependency edges
- Internal versioning per story (revision history within each node)
- New approaches create new plan files (separate documents, not branches within one)
- File viewer for humans to visualize the dependency graph and version history
- Machine-readable for agents, human-readable with tooling

**Status**: Concept — dependent on DAG story execution (above)

---

## Future

- Trace processing system
- Session-end hook
- Quality evaluation metrics
- Performance benchmarks

---

## File Structure

```
packages/
├── agent-email/          # Email CLI (built)
└── agent-media/          # Media CLI (planned)

skills/
├── agent-browser/        # Browser automation
├── agent-email/          # Email skill doc
└── agent-media/          # Media skill doc (planned)

utils/
├── config/               # YAML config loading
├── cli/                  # CLI adapters
│   ├── adapters/
│   │   ├── claude-code/  # Claude Code adapter + preflight
│   │   ├── codex/        # Codex adapter + preflight
│   │   └── mock/         # Mock adapter + preflight
│   ├── index.ts          # getCLITarget, runPreflight
│   └── types.ts          # CLITarget, PreflightHook interfaces
├── database/             # Database service layer
├── sync/                 # Skill sync to CLI target
├── linter/               # SKILL.md validation
├── run/                  # Execution orchestration
├── hooks/                # Git hooks
└── prompts/              # Prompt modules (survey, decompose, execute)

docs/
├── ROADMAP.md            # This file
├── skills/               # Skill spec
├── utils/                # Util docs
└── packages/             # Package docs
```
