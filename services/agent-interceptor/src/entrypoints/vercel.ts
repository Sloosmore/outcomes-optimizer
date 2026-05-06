import { handle } from "hono/vercel";
import { createApp } from "../app.js";
import { parseConfig } from "../config.js";
import { MemoryEventStore } from "../store/memory.js";
import { createStaticStore } from "@skill-networks/doppler-secrets";

/**
 * Vercel Edge / Serverless Functions entrypoint for the agent-interceptor.
 *
 * Uses the `hono/vercel` adapter to wrap the Hono application so it can be
 * deployed as a Vercel API route. Configuration is parsed from `process.env`
 * at cold-start time.
 *
 * NOTE: This uses an in-memory store which doesn't persist across function
 * invocations. For production, use the Cloudflare Workers entrypoint with KV.
 */

const store = new MemoryEventStore();
export default handle(createApp(
  parseConfig(createStaticStore(
    Object.fromEntries(
      Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined)
    )
  )),
  store
));
