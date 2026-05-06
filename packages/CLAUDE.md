# Packages

This directory contains standalone CLI tools for agent workflows.

## Architecture Pattern

Most tools in this directory follow the **session-based adapter pattern**:

1. **Define interfaces** - `EmailAdapter` (factory) and `EmailSession` (connection)
2. **Create a registry** - for dynamic adapter registration
3. **Implement adapters** - stateless factories that create/restore sessions
4. **Sessions hold state** - connection details, credentials, clean API
5. **Commands use sessions** - never pass adapter-specific parameters

This pattern enables:
- Clean API without leaky abstractions (no login/domain params everywhere)
- Clear session lifecycle (create, use, close)
- Easy credential restoration from saved state
- Swapping backends without changing command logic
- Testing with mock sessions

### Exception: Stateless Media Adapters

**agent-media** uses a simplified stateless adapter pattern because:
- Media generation APIs are request/response (no persistent connection)
- Image and audio generation are single synchronous operations
- Video uses job-based polling, not session state
- No credentials need to be restored between commands

For media adapters, commands call adapter methods directly (e.g., `adapter.generateImage()`)
rather than creating sessions. This is documented in `agent-media/src/adapters/types.ts`.

## Session vs Adapter

```typescript
// Adapter = stateless factory
interface EmailAdapter {
  createSession(options?: SessionOptions): Promise<EmailSession>;
  restoreSession(credentials: SessionCredentials): EmailSession;
}

// Session = stateful connection
interface EmailSession {
  readonly address: string;
  list(): Promise<EmailSummary[]>;
  read(id: string): Promise<Email>;
  close?(): Promise<void>;
}
```

## Example: agent-email

```
packages/agent-email/
  src/
    adapters/
      registry.ts    # AdapterRegistry - holds adapter instances
      types.ts       # EmailAdapter, EmailSession interfaces
      onesecmail.ts  # OneSecMailAdapter + OneSecMailSession
      mailtm.ts      # MailTmAdapter + MailTmSession
    commands/
      index.ts       # getSession(state) helper
      init.ts        # adapter.createSession()
      list.ts        # session.list()
      read.ts        # session.read(id)
```

## Adding a New Tool

1. Create `packages/<tool-name>/`
2. Define adapter + session interfaces in `src/adapters/types.ts`
3. Create registry in `src/adapters/registry.ts`
4. Implement at least one adapter with its session class
5. Commands restore sessions from state, call session methods

## Adapter Registration

```typescript
// Adapters are stateless - registered once as singletons
adapterRegistry.register("gmail", {
  adapter: new GmailAdapter(),
  description: "Gmail via OAuth",
  requiresAuth: true,
  ciCompatible: true,
});

// Usage in commands
const adapter = adapterRegistry.get("gmail");
const session = await adapter.createSession();  // or restoreSession(creds)
const emails = await session.list();
```

## Configuration

All tunable constants should be in `src/config.ts`:
- Request timeouts
- Response size limits
- File permissions
- Default polling intervals

This makes configuration discoverable and easy to adjust.

> E2E verification requirements live in the flow graph — see flow skills via `npx agent-core search "flow/" --type skill`
## Testing: Integration Test Gate

**Integration tests must never run by default.** Having an API key in the environment is not enough — tests must require an explicit opt-in flag so that `npm test` never silently consumes API credits.

### Standard gate (required in every test file with integration tests)

```typescript
// Gate: requires explicit opt-in regardless of API key presence
const RUN_INTEGRATION = !!process.env.RUN_INTEGRATION;

describe.skipIf(!RUN_INTEGRATION)("MyAdapter — real API (integration)", () => {
  // ...
});
```

### Running tests

```bash
# Unit tests only (default — no credits consumed)
npm test

# Unit + integration tests (explicit opt-in)
RUN_INTEGRATION=true GOOGLE_API_KEY=... npm test
RUN_INTEGRATION=true OPENAI_API_KEY=... npm test
```

### Rules

1. **`RUN_INTEGRATION=true` is the only gate.** Do not gate on API key presence alone — a key in the environment does not mean the developer wants to burn credits.
2. **All API-calling tests must be inside a `describe.skipIf(!RUN_INTEGRATION)` block.** No exceptions.
3. **Unit tests must always pass without `RUN_INTEGRATION`.** If a unit test imports real adapters, mock the network layer.
