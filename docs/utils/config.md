# Config System

> **Status:** Implemented

YAML config that drives CLI selection, database mode, skills paths, and eval behavior.

## Schema (Current)

```yaml
experiment:
  name: string            # min 1 char

database:
  adapter: none | local | cloud

cli:
  adapter: claude-code | codex | mock
  workingDir: string      # optional; relative paths are resolved under repo root

skills:                   # optional
  versioned: string       # path to committed skills (e.g., "skills/")
  draft: string           # optional; overrides adapter default draft path

identity:                 # optional
  email:
    adapter: gmail | mailtm | 1secmail
  phone:
    adapter: string
    number: string?
  browser:
    provider: string
    session_ttl: number?

eval:                     # optional
  data:
    type: cloud | local | none
    training_set: string? # when type=cloud
    local_path: string?   # when type=local
  policy: value_based | policy_gradient | actor_critic
  loop:
    enabled: boolean
    max_epochs: number
```

## CLI Configuration

**`cli.workingDir`** (optional)
- Overrides the CLI working directory.
- Relative paths are resolved inside the repo root and cannot escape the workspace.

## Skills Configuration

**`skills.versioned`** (optional)
- Path to version-controlled skills (defaults to `skills/` if omitted).

**`skills.draft`** (optional)
- Overrides the draft skills path for the current adapter.
- Defaults by adapter:
  - `claude-code` → `.claude/skills/`
  - `codex` → `.codex/skills/`
  - `mock` → `.mock/skills/`

## API

```typescript
import { loadConfig } from './utils/config'

const config = loadConfig()           // reads config.yaml from cwd
const config = loadConfig('/path')    // reads from custom path

// Types
type DatabaseAdapter = 'none' | 'local' | 'cloud'
type CLIAdapter = 'claude-code' | 'codex' | 'mock'
```

## Files

```
utils/config/
├── index.ts      # loadConfig() - loads YAML, validates with Zod
├── schema.ts     # Zod schema definition
├── types.ts      # TypeScript types (inferred from Zod)
└── __tests__/
```

## Validation

- Zod `safeParse()` for detailed error messages
- Throws on missing file, invalid YAML, or schema violation
