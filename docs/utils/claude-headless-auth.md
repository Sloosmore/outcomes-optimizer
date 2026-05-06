# Claude Headless Authentication

How to authenticate `claude` in headless environments (containers, CI runners, servers) where there is no browser available.

## How Claude Code stores credentials

Claude Code reads credentials from `~/.claude/.credentials.json`:

```json
{
  "claudeAiOauth": {
    "accessToken": "<short-lived token>",
    "refreshToken": "<long-lived token>",
    "expiresAt": 1234567890000
  }
}
```

It also requires `~/.claude.json` to exist (even as `{}`), otherwise it treats the environment as a fresh install and prompts for login.

Access tokens expire after ~8 hours. Claude Code automatically refreshes them using the refresh token and writes the new tokens back to disk. **Refresh tokens are single-use** — each refresh consumes the current one and issues a new one.

## Hydrating credentials on a headless machine

The pattern: write a credentials file with an **empty access token and `expiresAt: 0`**. Claude Code sees the token as expired and immediately refreshes on first use, establishing its own live session.

```bash
# Create the directory with restrictive permissions
(umask 077 && mkdir -p ~/.claude)
chmod 700 ~/.claude

# Write credentials using jq for safe JSON construction (handles any token characters)
jq -n \
  --arg rt "$CLAUDE_REFRESH_TOKEN" \
  '{claudeAiOauth:{accessToken:"",refreshToken:$rt,expiresAt:0,scopes:["user:inference","user:profile","user:sessions:claude_code"],subscriptionType:"max"}}' \
  > ~/.claude/.credentials.json
chmod 600 ~/.claude/.credentials.json

[ -f ~/.claude.json ] || (umask 077 && echo '{}' > ~/.claude.json)
```

> The production container uses Node.js (`node -e`) instead of `jq` to write the JSON; both approaches safely handle arbitrary token characters. Use whichever is available in your environment.

The `CLAUDE_REFRESH_TOKEN` comes from a fresh local login (see below).

## Getting a fresh refresh token

On a machine with a browser, log in via Claude Code:

```bash
claude auth login
# or just start claude and follow the login prompt
```

After login, extract the refresh token. **Run these interactively only — never in CI where output is logged.**

On macOS (reads from the keychain):

```bash
security find-generic-password -s "Claude Code-credentials" -w | \
  python3 -c "import json,sys; d=json.load(sys.stdin); print(d['claudeAiOauth']['refreshToken'])"
```

On Linux, read it directly from disk:

```bash
jq -r '.claudeAiOauth.refreshToken' ~/.claude/.credentials.json
```

Store it somewhere secure (e.g. a secrets manager) and inject it as `CLAUDE_REFRESH_TOKEN` when provisioning headless machines.

## Token rotation in CI

In normal operation, Claude Code handles token refresh automatically. The manual approach below is only needed when Claude Code itself is not running but the token must be kept alive (e.g. a custom integration calling the OAuth endpoint directly).

If the headless environment can write back to its own credentials file, the token chain is self-sustaining indefinitely. The workflow just needs to:

1. Check if `expiresAt` is near
2. Call the refresh endpoint if so
3. Write the new tokens back to disk

Refresh endpoint (note: `client_id` is the public OAuth client identifier from Claude Code's OAuth configuration and may change — if this stops working, search the Claude Code source for `client_id` in OAuth-related files to find the current value):

```bash
curl -s -X POST https://platform.claude.com/v1/oauth/token \
  -H "Content-Type: application/json" \
  -d "$(jq -n \
    --arg rt "$CLAUDE_REFRESH_TOKEN" \
    '{grant_type:"refresh_token",refresh_token:$rt,client_id:"9d1c250a-e61b-44d9-88ed-5944d1962f5e"}')"
# Returns: { "access_token": "...", "refresh_token": "...", "expires_in": ... }
```

## Multiple machines from one login

Each machine bootstrapped from the same refresh token will race to consume it. The first to refresh wins and gets a new chain; the others' bootstrap tokens become invalid.

To give each machine an independent session from a single login:
- Bootstrap machines **one at a time**, each triggering an immediate first-refresh before the next is bootstrapped
- Or log in separately for each machine

Once each machine has refreshed once, the sessions are fully independent.
