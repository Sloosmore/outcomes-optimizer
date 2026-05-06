# Webhook Secret Verification

## How It Works

The interceptor verifies incoming webhooks using HMAC-SHA256 signatures on a **per-endpoint basis**.

### Configuration

Two environment variables control secrets:

| Variable | Required | Description |
|---|---|---|
| `ENDPOINT_SECRETS` | No | JSON object mapping endpoint names to their HMAC secrets |
| `WEBHOOK_SECRET` | No | Global fallback secret (used when an endpoint has no entry in `ENDPOINT_SECRETS`) |

### Secret Resolution Order

For an incoming request to `/hooks/{endpoint}`:

1. Look up `ENDPOINT_SECRETS[endpoint]`
2. If value is `"__SKIP__"` → **no verification** (request passes through)
3. If value is a real string → **verify** `x-hub-signature-256` header using that secret
4. If no entry exists → fall back to `WEBHOOK_SECRET` (if set, verify; if unset, skip)

### Example Configuration

```toml
# wrangler.toml
[vars]
ENDPOINT_MAP = '{"instagram":"instagram","github":"github"}'
ENDPOINT_SECRETS = '{"github":"__SKIP__","instagram":"my-instagram-app-secret"}'
```

This means:
- **`/hooks/github`** — No signature verification (`__SKIP__`)
- **`/hooks/instagram`** — Verifies `x-hub-signature-256` using `my-instagram-app-secret`

### Signature Format

All endpoints use the `x-hub-signature-256` header with the format:

```
x-hub-signature-256: sha256=<hex-encoded HMAC-SHA256 digest>
```

This is compatible with:
- **GitHub** webhooks
- **Meta/Instagram** webhooks
- Any platform using the same HMAC-SHA256 scheme

### Adding a New Endpoint

1. Add the route mapping in `ENDPOINT_MAP`: `{"myservice":"normalizer-name"}`
2. Add the secret in `ENDPOINT_SECRETS`: `{"myservice":"the-webhook-secret"}`
3. Use `"__SKIP__"` as the secret value if the endpoint doesn't need verification

### Security Notes

- Signature comparison uses `timingSafeEqual` to prevent timing attacks
- Missing signatures are rejected (returns 401) when a secret is configured
- Store real secrets in Cloudflare Workers secrets (`wrangler secret put`), not in `wrangler.toml`
