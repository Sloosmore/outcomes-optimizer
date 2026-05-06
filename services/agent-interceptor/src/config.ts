// eslint-disable-next-line no-restricted-imports -- agent-interceptor owns its own DbSql abstraction layer (DbSql wraps postgres for the interceptor's routing logic, not direct entity queries)
import postgres from "postgres";
import type { InterceptorConfig, GatewayRuntime, DbSql } from "./types.js";
import type { SecretsStore } from "@skill-networks/doppler-secrets";

/** Default TCP port the Node.js entrypoint listens on. */
export const DEFAULT_PORT = 3_100;

function parseJsonRecord(raw: string, name: string): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${name} is not valid JSON: ${raw}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${name} must be a JSON object`);
  }
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v !== "string") {
      throw new Error(`${name}["${k}"] must be a string, got ${typeof v}`);
    }
  }
  return parsed as Record<string, string>;
}

function parseEndpointMap(raw: string): Record<string, string> {
  return parseJsonRecord(raw, "ENDPOINT_MAP");
}

function parseEndpointSecrets(raw: string | undefined): Record<string, string> | undefined {
  if (!raw) return undefined;
  return parseJsonRecord(raw, "ENDPOINT_SECRETS");
}

function parseAllowedSessionKeyPrefixes(raw: string | undefined): string[] {
  if (!raw) return ["sub:"];
  return raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
}

function parseGatewayRuntime(raw: string | undefined): GatewayRuntime {
  if (!raw || raw === "openclaw") return "openclaw";
  if (raw === "custom") return "custom";
  throw new Error(`GATEWAY_RUNTIME must be "openclaw" or "custom", got "${raw}"`);
}

/**
 * Create a DbSql adapter backed by postgres if DATABASE_URL is available.
 * Returns undefined when DATABASE_URL is not set — proxy routing is skipped silently.
 */
function createDbSql(databaseUrl: string | undefined): DbSql | undefined {
  if (!databaseUrl) return undefined;
  const sql = postgres(databaseUrl, { max: 2 });
  return async (query, params) => {
    const rows = await sql.unsafe(query, params as postgres.ParameterOrJSON<postgres.SerializableParameter>[]);
    return { rows: rows as Array<Record<string, unknown>> };
  };
}

/**
 * Parse interceptor configuration from a SecretsStore.
 *
 * @param env - SecretsStore (Doppler, static env, or other source).
 */
export function parseConfig(env: SecretsStore): InterceptorConfig {
  const gatewayUrl = env.getOptional("GATEWAY_URL");
  const gatewayAuthToken = env.getOptional("GATEWAY_AUTH_TOKEN");
  return {
    webhookSecret: env.getOptional("WEBHOOK_SECRET"),
    endpointSecrets: parseEndpointSecrets(env.getOptional("ENDPOINT_SECRETS")),
    endpointMap: parseEndpointMap(env.getOptional("ENDPOINT_MAP") ?? "{}"),
    webhookVerifyToken: env.getOptional("WEBHOOK_VERIFY_TOKEN"),
    agentSecret: env.getOptional("AGENT_SECRET"),
    gatewayUrl,
    gatewayAuthToken,
    // Sub-agent gateway — defaults to main gateway if not overridden.
    gatewaySubUrl: env.getOptional("GATEWAY_SUB_URL") ?? gatewayUrl,
    gatewaySubAuthToken: env.getOptional("GATEWAY_SUB_AUTH_TOKEN") ?? gatewayAuthToken,
    gatewayRuntime: parseGatewayRuntime(env.getOptional("GATEWAY_RUNTIME")),
    dbSql: createDbSql(env.getOptional("DATABASE_URL")),
    allowedSessionKeyPrefixes: parseAllowedSessionKeyPrefixes(env.getOptional("ALLOWED_SESSION_KEY_PREFIXES")),
  };
}
