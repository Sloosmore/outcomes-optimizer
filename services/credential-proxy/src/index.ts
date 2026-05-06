/**
 * credential-proxy — HTTP sidecar entry point (composition root)
 *
 * Starts an HTTP server that:
 *   - Accepts proxied fetch requests from the agent process
 *   - Resolves credentials from the resource registry + Doppler
 *   - Injects them and forwards to the upstream API
 *   - Returns the upstream response verbatim
 *   - Emits agent events via the injected EventEmitterAdapter
 *
 * Credentials never appear in the agent process environment.
 *
 * Security features:
 *   - Destination validation (closes prompt-injection exfiltration)
 *   - X-Resource sanitization (closes CRLF/path-traversal)
 *   - SSRF guard (closes DNS rebinding, IPv6 bypasses)
 *   - Uniform error responses (closes enumeration oracle)
 *   - Doppler scope constraint (closes confused-deputy)
 *   - No redirect following on proxied requests
 *   - Admin cache invalidation endpoint (localhost-only)
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  CREDENTIAL_PROXY_PORT_ENV,
  DOPPLER_SERVICE_TOKEN_ENV,
  DOPPLER_TOKEN_ENV,
  DOPPLER_PROJECT_ENV,
  DOPPLER_CONFIG_ENV,
  SUPABASE_URL_ENV,
  SUPABASE_SERVICE_KEY_ENV,
  DEFAULT_PORT,
} from "./config.js";
import { createLogger, registerDrain, DatabaseDrain, type DatabaseDrainDeps } from "@skill-networks/logger";
import { getDb, isDatabaseEnabled } from "@skill-networks/database/drizzle";
import { logs } from "@skill-networks/database/schema";
import { DopplerCredentialStore } from "./store/doppler.js";
import { handleProxy, handleAdminCacheInvalidate } from "./handler.js";

if (process.env['DATABASE_URL']) {
  registerDrain(new DatabaseDrain({ getDb: getDb as unknown as DatabaseDrainDeps['getDb'], isDatabaseEnabled, logsTable: logs }));
}

const logger = createLogger('credential-proxy');

// ── Process identity ──────────────────────────────────────────────────────────

const PROCESS_ID = globalThis.crypto.randomUUID();
const PROCESS_NAME = "credential-proxy";

// ── Configuration ─────────────────────────────────────────────────────────────

const PORT = parseInt(process.env[CREDENTIAL_PROXY_PORT_ENV] ?? String(DEFAULT_PORT), 10);
const DOPPLER_TOKEN = process.env[DOPPLER_SERVICE_TOKEN_ENV] ?? process.env[DOPPLER_TOKEN_ENV] ?? "";
if (!process.env[DOPPLER_SERVICE_TOKEN_ENV] && process.env[DOPPLER_TOKEN_ENV]) {
  logger.warn('Using fallback DOPPLER_TOKEN — set DOPPLER_SERVICE_TOKEN for production');
}
const DOPPLER_PROJECT = process.env[DOPPLER_PROJECT_ENV];
const DOPPLER_CONFIG = process.env[DOPPLER_CONFIG_ENV];
if (!DOPPLER_PROJECT) throw new Error(`${DOPPLER_PROJECT_ENV} must be set`);
if (!DOPPLER_CONFIG) throw new Error(`${DOPPLER_CONFIG_ENV} must be set`);

const SUPABASE_URL = process.env[SUPABASE_URL_ENV] ?? "";
const SUPABASE_SERVICE_KEY = process.env[SUPABASE_SERVICE_KEY_ENV] ?? "";

/**
 * Proxy-side allowlist of env var names that may ever be fetched from Doppler.
 *
 * This is the Doppler scope constraint: even if the DB or X-Resource header
 * references a different name, the proxy refuses to fetch it unless it's here.
 * This closes the confused-deputy attack.
 *
 * Extend this list as new credentials are onboarded to the proxy.
 */
const ALLOWED_ENV_VARS: ReadonlySet<string> = new Set([
  "YOUTUBE_REALENTRY_REFRESH_TOKEN",
  "GITHUB_PAT",
  "INSTAGRAM_TRIANGLEBENDER_ACCESS_TOKEN",
  "INSTAGRAM_SQUAREBENT_ACCESS_TOKEN",
  "SUPABASE_SERVICE_KEY",
  // Agent-media credentials
  "GOOGLE_API_KEY",
  "OPENAI_API_KEY",
  "FAL_KEY",
  // YouTube OAuth credentials (hay-maker account)
  "YOUTUBE_REALENTRY_CLIENT_ID",
  "YOUTUBE_REALENTRY_CLIENT_SECRET",
  // Gmail OAuth credentials
  "GMAIL_CLIENT_ID",
  "GMAIL_CLIENT_SECRET",
  "GMAIL_REFRESH_TOKEN",
  // Egress proxy URLs — one per Decodo dedicated IP
  "PROXY_01_URL",
  "PROXY_02_URL",
  "PROXY_03_URL",
  // Claude OAuth credentials (for Anthropic API access via OAuth refresh flow)
  "CLAUDE_OAUTH_CLIENT_ID",
  "CLAUDE_OAUTH_CLIENT_SECRET",
  "CLAUDE_REFRESH_TOKEN",
  "CLAUDE_OAUTH_REFRESH_TOKEN",
]);

// ── Store + Emitter ───────────────────────────────────────────────────────────

const store = new DopplerCredentialStore({
  serviceToken: DOPPLER_TOKEN,
  project: DOPPLER_PROJECT,
  config: DOPPLER_CONFIG,
  ttlMs: 5 * 60 * 1000,
  allowedKeys: ALLOWED_ENV_VARS,
});

async function createEmitter(): Promise<{ emit(event: unknown): void }> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    logger.warn('SUPABASE_URL or SUPABASE_SERVICE_KEY not set — event emission disabled');
    return { emit() {} };
  }
  try {
    const { SupabaseEventEmitterAdapter } = await import("@skill-networks/agent-events");
    return new SupabaseEventEmitterAdapter(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  } catch {
    logger.warn('@skill-networks/agent-events not available — event emission disabled');
    return { emit() {} };
  }
}

// ── Boot ──────────────────────────────────────────────────────────────────────

async function boot() {
  const emitter = await createEmitter();
  const deps = { store, emitter, processId: PROCESS_ID, processName: PROCESS_NAME };

  async function requestHandler(
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
    const url = req.url ?? "/";

    try {
      if (url === "/health" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", service: "credential-proxy" }));
        return;
      }

      if (url === "/proxy" || url.startsWith("/proxy?")) {
        await handleProxy(req, res, deps);
        return;
      }

      if (url === "/admin/cache/invalidate") {
        await handleAdminCacheInvalidate(req, res, deps.store);
        return;
      }

      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
    } catch (err) {
      logger.error('Unhandled error', err instanceof Error ? err : { error: String(err) });
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal server error" }));
      }
    }
  }

  const server = createServer(requestHandler);

  server.listen(PORT, "0.0.0.0", () => {
    logger.info('Listening', { port: PORT });
    logger.info('Doppler project', { project: DOPPLER_PROJECT, config: DOPPLER_CONFIG });
    logger.info('Allowed keys configured', { count: ALLOWED_ENV_VARS.size });
  });

  server.on("error", (err) => {
    logger.error('Server error', err instanceof Error ? err : { error: String(err) });
    process.exit(1);
  });

  // Graceful shutdown.
  process.on("SIGTERM", () => {
    server.close(() => {
      logger.info('Shut down gracefully');
      process.exit(0);
    });
  });

  process.on("SIGINT", () => {
    server.close(() => {
      logger.info('Shut down gracefully');
      process.exit(0);
    });
  });

  return server;
}

boot().catch((err) => {
  logger.fatal('Fatal boot error', err instanceof Error ? err : { error: String(err) });
  process.exit(1);
});
