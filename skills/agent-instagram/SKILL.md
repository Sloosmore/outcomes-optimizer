---
name: agent-instagram
description: Post photos, videos, and reels to Instagram. Use when the user needs to publish content to Instagram, check post status, or view profile information.
allowed-tools: Bash(agent-instagram:*)
---

# Instagram Operations with agent-instagram

Post photos, videos, and reels to Instagram using the Graph API.

## Quick Start

```bash
agent-instagram login --token <access_token> --account-id <business_id>
agent-instagram post photo --image https://example.com/hero.png --caption "Check this out"
agent-instagram profile
```

## Authentication

Login requires a Meta Business Suite access token and Instagram Business Account ID.

```bash
# Token-based auth (recommended)
agent-instagram login --token <access_token> --account-id <business_id>

# Environment variable auth
export INSTAGRAM_ACCESS_TOKEN=...
export INSTAGRAM_BUSINESS_ACCOUNT_ID=...
agent-instagram login
```

Session credentials are persisted to `~/.agent-instagram/` (or `AGENT_INSTAGRAM_STATE_DIR`).

## Commands

### Login

```bash
agent-instagram login --token <token> --account-id <id>   # Explicit credentials
agent-instagram login                                      # From environment variables
agent-instagram login --adapter instagram-api              # Specify adapter
agent-instagram login --json                               # Machine-readable output
```

### Post Photo

```bash
agent-instagram post photo --image <url> --caption "Caption text"
agent-instagram post photo --image <url> --json
```

The image URL must be publicly accessible. Instagram fetches it server-side.

### Post Video

```bash
agent-instagram post video --video <url> --caption "Caption text"
agent-instagram post video --video <url> --cover <thumbnail_url>
agent-instagram post video --video <url> --json
```

Video uploads are processed asynchronously. The CLI polls until processing completes before publishing.

### Post Reel

```bash
agent-instagram post reel --video <url> --caption "Trending reel"
agent-instagram post reel --video <url> --cover <thumbnail_url>
agent-instagram post reel --video <url> --share-to-feed
agent-instagram post reel --video <url> --json
```

### Check Status

```bash
agent-instagram status <post-id>          # Check upload/publish status
agent-instagram status <post-id> --json   # Machine-readable output
```

### Profile

```bash
agent-instagram profile                   # Show account info
agent-instagram profile --json            # Machine-readable output
```

## JSON Output

Add `--json` to any command for machine-readable output:

```bash
agent-instagram login --json
agent-instagram post photo --image <url> --json
agent-instagram status <id> --json
agent-instagram profile --json
```

## Background Agent Pattern for Video

Video and reel uploads can take time to process. Use the background agent pattern:

```
1. Run: agent-instagram post video --video <url> --caption "text" --json
2. If the upload is slow, spawn a background agent with prompt:
   "Check post status using `agent-instagram status <post-id> --json` every 30 seconds.
    Report when status is FINISHED or PUBLISHED."
3. Continue with other work while video processes
```

## Environment Variables

```bash
INSTAGRAM_ACCESS_TOKEN=...          # Graph API access token
INSTAGRAM_BUSINESS_ACCOUNT_ID=...   # Instagram Business Account ID
AGENT_INSTAGRAM_STATE_DIR=...       # Custom state directory (optional, must be absolute)
```

## Example: Post a Photo with Caption

```bash
# Login
agent-instagram login --token "EAAx..." --account-id "17841400..."

# Post
agent-instagram post photo --image "https://cdn.example.com/hero.jpg" --caption "New blog post is live! Check the link in bio."

# Verify
agent-instagram profile --json
```

## Example: Post a Reel

```bash
# Login (if not already)
agent-instagram login

# Post reel with cover image
agent-instagram post reel \
  --video "https://cdn.example.com/reel.mp4" \
  --cover "https://cdn.example.com/thumb.jpg" \
  --caption "Behind the scenes"

# Check result
agent-instagram status <post-id>
```

## State Management

- Session state is stored in `~/.agent-instagram/session.json` (or `AGENT_INSTAGRAM_STATE_DIR`)
- One session per installation (new `login` overwrites previous)
- Credentials are stored with restricted file permissions (0600)

## Verification

**What to check:** After login, the CLI can reach the Instagram Graph API and return the live account profile. After a post, the returned media ID resolves to a real published object.

**How to run:**
```bash
# Confirm credentials are accepted and the profile is returned from the live API
agent-instagram login
agent-instagram profile
```

The `profile` output must include the live account's username and follower count — values that can only come from a real Graph API response. A mock or cached response would produce static or stale values.

To confirm posting end-to-end, publish a photo and verify the returned post ID resolves:
```bash
POST_ID=$(agent-instagram post photo --image <publicly-accessible-url> --caption "verification test" --json | jq -r '.id')
agent-instagram status "$POST_ID"
# Status must show "PUBLISHED" — not "IN_PROGRESS" or an error
```

**What failure mode it catches:** An expired access token, a revoked business account, or a misconfigured `INSTAGRAM_ACCESS_TOKEN` environment variable will cause `profile` to return an auth error or empty data. Checking only that the CLI exits 0 on `login` would miss this — login succeeds as long as credentials are written to disk, regardless of whether the token is still valid against the Graph API.

**Why it cannot be gamed:** The `profile` command issues a live `GET /me` call to `graph.facebook.com`. The follower count and username in the response are served from Meta's infrastructure. A stub cannot produce matching live account data without making the real API call.
