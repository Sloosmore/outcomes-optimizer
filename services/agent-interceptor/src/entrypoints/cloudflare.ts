import { createApp } from "../app.js";
import { parseConfig } from "../config.js";
import { KVEventStore } from "../store/kv.js";
import { createSecretsStore } from "@skill-networks/doppler-secrets";
import type { SecretsStore } from "@skill-networks/doppler-secrets";

/**
 * Cloudflare Workers environment bindings.
 *
 * `WEBHOOK_EVENTS` is a required KV namespace binding where normalised
 * webhook events are stored for asynchronous consumption by the gateway.
 * `DOPPLER_TOKEN` is the only secret bound at deploy time — all other
 * secrets are fetched from Doppler at runtime via createSecretsStore.
 * `DOPPLER_PROJECT` and `DOPPLER_CONFIG` are required vars set via `wrangler secret put` or `[vars]`.
 */
interface CloudflareEnv {
  WEBHOOK_EVENTS: KVNamespace;
  DOPPLER_TOKEN: string;
  DOPPLER_PROJECT?: string;
  DOPPLER_CONFIG?: string;
}

let initPromise: Promise<SecretsStore> | null = null;

export default {
  async fetch(request: Request, env: CloudflareEnv) {
    if (!initPromise) {
      if (!env.DOPPLER_PROJECT) {
        throw new Error("DOPPLER_PROJECT env var is required");
      }
      if (!env.DOPPLER_CONFIG) {
        throw new Error("DOPPLER_CONFIG env var is required");
      }
      initPromise = createSecretsStore({
        serviceToken: env.DOPPLER_TOKEN,
        project: env.DOPPLER_PROJECT,
        config: env.DOPPLER_CONFIG,
        fallback: env.WEBHOOK_EVENTS,
      }).catch((err) => {
        // Clear so the next request retries rather than caching the rejection permanently.
        initPromise = null;
        throw err;
      });
    }
    const secretsStore = await initPromise;
    const config = parseConfig(secretsStore);
    const store = new KVEventStore(env.WEBHOOK_EVENTS);
    return createApp(config, store).fetch(request);
  },
};
