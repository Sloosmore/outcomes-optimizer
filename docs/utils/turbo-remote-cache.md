# Turborepo Remote Cache

The dispatch path uses Turborepo's content-hashed build cache (see `turbo.json` and `utils/dispatch/provisioners/compose.ts`). Each dispatch host already shares the cache across worktrees via `TURBO_CACHE_DIR=~/.cache/turbo-shared`. The remote cache extends that sharing across machines — dev laptops, CI, multiple hosts — so the first machine to build a given input set is the only one that pays for it.

## Vercel-hosted (recommended)

Free tier: 100 GB / month of cache artifacts across the team.

### One-time per machine (dev laptop, dispatch host, etc.)

```bash
pnpm exec turbo login   # opens browser for Vercel auth
pnpm exec turbo link    # picks the Vercel team to attach this repo to
```

`turbo link` writes `.turbo/config.json` (already gitignored) with the team and project ID. Future builds publish/restore from `https://api.vercel.com` automatically.

### CI / unattended hosts (no browser)

Set two env vars instead of running `turbo login`:

```bash
TURBO_TOKEN=<personal access token from https://vercel.com/account/tokens>
TURBO_TEAM=<team slug>
```

These can live in repo secrets (`gh secret set TURBO_TOKEN` for GitHub Actions) or any secrets manager.

### Verifying it works

After running `turbo link`, do a build, blow away the local cache, and re-run:

```bash
pnpm exec turbo run build --filter=agent-livestream
rm -rf ~/.cache/turbo-shared
pnpm exec turbo run build --filter=agent-livestream   # should report "FULL TURBO" via remote
```

## Self-hosted alternative

If Vercel becomes a problem, swap to `ducktors/turborepo-remote-cache` — drop-in HTTP server with S3 or local-disk backend. Same client config, just override `TURBO_API` to point at your server. No code changes on this side.

## Skipping remote cache for one run

```bash
TURBO_REMOTE_CACHE_TIMEOUT=0 pnpm exec turbo run build   # treat remote cache as unreachable
# or
pnpm exec turbo run build --no-cache   # skip both local AND remote
```
