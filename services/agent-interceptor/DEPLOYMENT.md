# KV Event Bus Deployment Guide

This guide covers deploying the store-only webhook architecture: CF Worker → KV event store → consumer polls → gateway.

## Architecture Overview

1. **CF Worker**: Receives webhooks, validates signatures, normalizes payloads, stores in KV
2. **KV Store**: Durable event storage with 24h TTL
3. **Consumer**: Polls KV, forwards events to gateway, handles failures
4. **Gateway**: Receives normalized webhook events for agent processing

## Prerequisites

- Cloudflare account with Workers and KV enabled
- OpenClaw gateway running and accessible
- `wrangler` CLI installed and authenticated

## 1. Create KV Namespace

```bash
# Create production namespace
wrangler kv:namespace create "WEBHOOK_EVENTS"

# Create preview namespace for testing
wrangler kv:namespace create "WEBHOOK_EVENTS" --preview
```

Update `wrangler.toml` with the returned namespace IDs:
```toml
[[kv_namespaces]]
binding = "WEBHOOK_EVENTS"
id = "your-prod-namespace-id"
preview_id = "your-preview-namespace-id"
```

## 2. Configure Environment Variables

Set in `wrangler.toml` or via Cloudflare dashboard:

```toml
[vars]
ENDPOINT_MAP = '{"instagram":"instagram","github":"github"}'
WEBHOOK_SECRET = "your-webhook-secret"
WEBHOOK_VERIFY_TOKEN = "your-verify-token"
```

For production secrets, use `wrangler secret`:
```bash
wrangler secret put WEBHOOK_SECRET
wrangler secret put WEBHOOK_VERIFY_TOKEN
```

## Schema Migration Note

This service uses `timestamp` (Standard Webhooks field name). If you are upgrading from
a version that stored events with `receivedAt`, deploy the worker and consumer
simultaneously, or ensure the KV namespace is empty before deploying the new consumer.
Events written in the old format will fail validation and be skipped.

## 3. Deploy Worker

```bash
# Deploy to preview
wrangler publish

# Deploy to production
wrangler publish --env production
```

## 4. Setup Consumer

The consumer can run in multiple ways:

### Option A: OpenClaw Cron Job

Add to your OpenClaw config:
```yaml
cronJobs:
  - name: "webhook-consumer"
    schedule: "*/2 * * * *"  # Every 2 minutes
    agentTurn:
      message: "Run webhook consumer"
      code: |
        import { consumeEvents } from "./services/agent-interceptor/src/poll/consume.js";
        const result = await consumeEvents({
          CF_ACCOUNT_ID: process.env.CF_ACCOUNT_ID,
          CF_API_TOKEN: process.env.CF_API_TOKEN,
          CF_KV_NAMESPACE: process.env.CF_KV_NAMESPACE,
          GATEWAY_URL: "http://localhost:18789",
          GATEWAY_AUTH_TOKEN: process.env.GATEWAY_AUTH_TOKEN,
          POLL_LIMIT: "50"
        });
        return `Processed ${result.processed}, failed ${result.failed}`;
```

### Option B: Standalone Node.js Script

Create `scripts/consume-webhooks.js`:
```javascript
import { consumeEvents } from "../services/agent-interceptor/src/poll/consume.js";

async function main() {
  try {
    const result = await consumeEvents();
    console.log(`Processed: ${result.processed}, Failed: ${result.failed}`);
    if (result.errors.length) console.error("Errors:", result.errors);
  } catch (err) {
    console.error("Fatal error:", err);
    process.exit(1);
  }
}

// Run every 2 minutes
setInterval(main, 120000);
main(); // Run immediately
```

Set environment variables:
```bash
export CF_ACCOUNT_ID="your-account-id"
export CF_API_TOKEN="your-api-token"
export CF_KV_NAMESPACE="your-kv-namespace-id"
export GATEWAY_URL="https://your-gateway.com"
export GATEWAY_AUTH_TOKEN="your-gateway-token"
```

Run with: `node scripts/consume-webhooks.js`

## 5. Configure Webhook URLs

Update your webhook providers to point to:
```
https://your-worker.your-subdomain.workers.dev/hooks/{mapping}
```

Where `{mapping}` matches keys in your `ENDPOINT_MAP`.

## 6. Monitoring

### Health Checks

- Worker health: `GET https://your-worker.workers.dev/health`
- Consumer logs: Check OpenClaw logs or Node.js console output
- KV storage: Use Cloudflare dashboard to monitor KV usage

### Key Metrics

- Event processing latency (should be <5 minutes)
- Event TTL warnings (events >20h old)
- Consumer error rates
- Gateway delivery success rates

### Alerts

Set up alerts for:
- Consumer down for >10 minutes
- Events approaching 24h TTL
- High error rates (>10% failures)
- KV API rate limiting

## 7. Scaling Considerations

### High Throughput

- Consider multiple consumer instances with different KV namespace sharding
- Monitor KV API rate limits (1000 ops/sec per namespace)
- Consider upgrading to Cloudflare Queues for guaranteed delivery

### Consumer Resilience

- Run consumers from multiple locations/systems
- Implement dead letter queue for failed events
- Monitor consumer heartbeat/health

### Event Retention

- 24h TTL may be too short for maintenance windows
- Consider extending to 48-72h for production systems
- Implement event replay capability for system recovery

## Failure Scenarios

### Worker Down
- Webhooks return 5xx errors to providers
- Providers typically retry with exponential backoff
- Fix and redeploy worker ASAP

### KV Unavailable  
- Worker returns 500 to webhooks
- Same recovery as worker down
- Events lost during outage period

### Consumer Down
- Events accumulate in KV until TTL expiration
- Start consumer ASAP to process backlog
- Monitor event age warnings

### Gateway Down
- Consumer fails to forward events
- Events remain in KV and will be retried
- Consumer logs errors but continues processing other events

## Rollback Plan

### Emergency Rollback

1. Switch webhook URLs back to previous system
2. Stop current consumer to prevent data loss
3. Export any pending events from KV if needed
4. Investigate and fix issues before re-enabling

### Data Recovery

If events are lost:
1. Check KV for any remaining events
2. Use webhook provider replay features if available
3. Manual recovery from logs/monitoring systems

This architecture trades some complexity for improved resilience and scalability compared to direct HTTP forwarding.