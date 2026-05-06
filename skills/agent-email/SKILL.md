---
name: throwmail
description: Manages temporary email inboxes for verification flows, reading emails, and extracting links/codes. Use when you need to receive verification emails during account creation or extract information from emails.
allowed-tools: Bash(throwmail:*)
---

# Email Operations with throwmail

## Global Identity

In workflow contexts, email is pre-initialized at the workflow level. Use `throwmail address` to get the current inbox:

```bash
throwmail address                   # Get current inbox (pre-initialized)
throwmail wait --from "noreply"     # Wait for verification email
throwmail extract-link              # Get verification link
```

The inbox is shared across orchestrator and all subagents via `AGENT_EMAIL_STATE_DIR`.

## Adapters

Four email backends are available:

| Adapter | Flag | Privacy | CI-Compatible | Send Support |
|---------|------|---------|---------------|--------------|
| gmail | `--adapter gmail` | Real email | Yes (with OAuth) | No |
| mail.tm | `--adapter mailtm` | Private (authenticated) | Yes | No |
| 1secmail | `--adapter 1secmail` (default) | Public (anyone can read) | No (blocked) | No |
| supabase | `--adapter supabase` | Private (RLS-protected) | Yes | Yes |

**Recommendation:** Gmail adapter is configured at workflow level for reliable delivery. Disposable adapters are blocked by many services. For agent-to-agent communication, use the supabase adapter — it supports both sending and receiving with no external credentials needed.

## Sending Messages (Supabase-backed only)

For agent-to-agent email exchange using the supabase adapter:

```bash
throwmail init --adapter supabase         # Create supabase-backed inbox
throwmail send <to> <subject> <body>      # Send to another supabase inbox
throwmail wait --adapter supabase         # Wait for incoming message
```

Note: The `send` command only works with the `supabase` adapter. Traditional email adapters (mailtm, gmail, 1secmail) are receive-only from the CLI.

## Known blocked services

Some services block disposable email domains. If signup fails with "email blocked" or similar, the service may require a real email (use gmail adapter).

| Service | gmail | mailtm | 1secmail | Notes |
|---------|-------|--------|----------|-------|
| Substack | OK | Blocked | Blocked | Blocks all disposable domains |
| Hashnode | OK | OK | Blocked | Blocks some disposable domains |

## Quick start (workflow context)

```bash
throwmail address                   # Get pre-initialized inbox
throwmail wait --from "noreply"     # Wait for verification email
throwmail extract-link              # Get verification link
```

## Quick start (standalone/testing)

```bash
throwmail init --adapter gmail      # Initialize with Gmail (requires OAuth)
throwmail init --adapter mailtm     # Initialize with mail.tm
throwmail address                   # Show current address
```

## Core workflow (verification)

1. Get address: `throwmail address`
2. Use address in signup form (via agent-browser)
3. Wait for email: `throwmail wait --timeout 60`
4. Extract link: `throwmail extract-link`
5. Navigate to link (via agent-browser)

## Commands

### Inbox

```bash
throwmail address                   # Show current address (use this first)
throwmail init --adapter gmail      # Initialize with Gmail (standalone only)
throwmail init --adapter mailtm     # Initialize with mail.tm (standalone only)
```

### Reading

```bash
throwmail list                      # List all emails
throwmail list --from "substack"    # Filter by sender
throwmail read latest               # Read most recent
throwmail read <id>                 # Read specific email
throwmail read latest --text        # Text body only
throwmail read latest --html        # HTML body only
throwmail count                     # Count emails
```

### Waiting

```bash
throwmail wait                      # Wait for any email (60s default)
throwmail wait --timeout 120        # Custom timeout
throwmail wait --from "substack"    # Wait for specific sender
throwmail wait --subject "verify"   # Wait for subject containing text
```

### Extraction

```bash
throwmail extract-link              # First link from latest email
throwmail extract-link --all        # All links
throwmail extract-link <id>         # Links from specific email
throwmail extract-code              # Find OTP/verification code
throwmail extract-code --pattern "\d{6}"  # Custom regex
```

### JSON output

Add `--json` to any read/list/wait/extract command for machine-readable output:

```bash
throwmail list --json
throwmail read latest --json
throwmail extract-link --json
```

## Example: Account verification (workflow context)

```bash
# Get the pre-initialized address
throwmail address
# Output: temp-inbox-abc123@tempmail.example

# (use agent-browser to fill signup form with this email)

# Wait for verification
throwmail wait --from "noreply" --timeout 120
# Output: Email received from "noreply@example.com"

# Extract and use verification link
throwmail extract-link
# Output: https://example.com/verify?token=abc123

# (use agent-browser to navigate to the link)
```

## Example: OTP verification

```bash
# Get current address
throwmail address
# Output: temp-inbox-abc123@tempmail.example

# (trigger OTP send via agent-browser)

throwmail wait --subject "code" --timeout 60
throwmail extract-code
# Output: 847291
```

## State management

- Inbox state is stored in `~/.agent-email/current.json` (or `AGENT_EMAIL_STATE_DIR`)
- In workflows, state is shared across all contexts via `AGENT_EMAIL_STATE_DIR`
- One inbox per session (new `init` overwrites previous)
- The `wait` command tracks seen emails to only return new ones

## Verification

**What to check:** The CLI initializes a real inbox, returns a valid email address, and the address can receive email that is then readable via `list` or `wait`.

**How to run (standalone, using the 1secmail adapter):**
```bash
agent-email init --adapter 1secmail
agent-email address
# Output: <random>@1secmail.com (or similar disposable domain)
```

Confirm the output is a syntactically valid email address (contains `@` and a domain). Then trigger a real send and verify receipt:
```bash
# Send a test message to that address from an external tool or API
agent-email wait --timeout 60
agent-email list
```

The `list` output must show the actual email subject and sender — not a placeholder or empty list.

**What failure mode it catches:** A broken adapter, missing state file, or mis-configured `AGENT_EMAIL_STATE_DIR` will cause `address` to fail or `list` to return empty even after email delivery. Checking only the exit code of `init` would not catch a state-file misconfiguration that silently drops incoming messages.

**Why it cannot be gamed:** Receipt confirmation requires a real email to traverse the disposable mail provider's infrastructure and appear in the inbox. No mock can produce a real timestamped message with actual subject and body content from the external sender.
