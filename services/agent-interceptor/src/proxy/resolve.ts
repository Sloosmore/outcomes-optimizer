/**
 * Minimal DB interface for proxy resolution queries.
 * Accepts a SQL string and positional parameters, returns rows.
 *
 * IMPORTANT: callers MUST use parameterized queries with $1..$N placeholders.
 * Never interpolate user-controlled values directly into the query string.
 */
export type DbSql = (
  query: string,
  params: unknown[]
) => Promise<{ rows: Array<Record<string, unknown>> }>;

/**
 * Resolve a proxy agent for the given resource by looking up a `proxy`-typed
 * resource link in the database.
 *
 * Returns an undici ProxyAgent, or null (no proxy configured).
 * Throws if the linked proxy resource's urlEnvVar is not present in env.
 *
 * NOTE: undici is loaded via dynamic import to avoid bundling WeakRef-dependent
 * module-level code into Cloudflare Workers (which fails validation). The proxy
 * feature is Node.js-only; CF Workers never configure dbSql so this path is
 * never reached in that runtime.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function resolveProxy(
  resourceName: string,
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
  dbSql: DbSql
// eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(resourceName)) {
    throw new Error(`Invalid resource name: "${resourceName}". Must match [a-zA-Z0-9_-]{1,128}`);
  }
  const result = await dbSql(
    `SELECT r.config FROM resource_links rl
JOIN resources r ON r.id = rl.to_id
WHERE rl.from_id = (SELECT id FROM resources WHERE name = $1)
AND rl.link_type = 'proxy'
LIMIT 1`,
    [resourceName]
  );

  if (result.rows.length === 0) {
    return null;
  }

  const config = result.rows[0]["config"] as Record<string, unknown> | null;
  if (!config || typeof config !== "object") {
    throw new Error(`Proxy resource for "${resourceName}" has no config`);
  }
  const urlEnvVar = config["urlEnvVar"];
  if (typeof urlEnvVar !== "string" || urlEnvVar.length === 0) {
    throw new Error(`Proxy config for "${resourceName}" missing urlEnvVar`);
  }
  if (!/^PROXY_[A-Z0-9_]+$/.test(urlEnvVar)) {
    throw new Error(`Proxy urlEnvVar "${urlEnvVar}" must match PROXY_* naming convention`);
  }
  const url = env[urlEnvVar];

  if (!url) {
    throw new Error(
      `Proxy env var ${urlEnvVar} is not set for resource "${resourceName}"`
    );
  }

  // undici ProxyAgent only supports HTTP and HTTPS proxies via CONNECT tunneling.
  // SOCKS4/SOCKS5 are not supported.
  const protocol = new URL(url).protocol;
  if (protocol !== "http:" && protocol !== "https:") {
    throw new Error(
      `Proxy protocol "${protocol}" is not supported. Use http:// or https://.`
    );
  }

  // Dynamic import keeps undici out of the module-level bundle so CF Workers
  // validation does not trip on WeakRef (used at module init in undici).
  const { ProxyAgent } = await import("undici");
  return new ProxyAgent(url);
}
