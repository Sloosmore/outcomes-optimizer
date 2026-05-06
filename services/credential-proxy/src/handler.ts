/**
 * handler.ts — HTTP handler logic for the credential proxy.
 *
 * Extracted from index.ts so that the composition root (index.ts) can inject
 * dependencies (store, emitter) without this module knowing about their
 * concrete implementations.
 *
 * NOTE: This file must NOT import from @skill-networks/agent-events or
 * services/agent-events. The emitter interface is defined locally using
 * structural typing.
 */

import { type IncomingMessage, type ServerResponse } from "node:http";
import https from "node:https";
import { createLogger } from "@skill-networks/logger";
import { SocksProxyAgent } from "socks-proxy-agent";
import { getNativeFetch } from "./native-fetch.js";
import { resolveCredentials, isBlockedBySSRF } from "./router.js";
import type { CredentialStore } from "./store/interface.js";

const logger = createLogger('credential-proxy');

// ── Local emitter interface (structural typing — no import from agent-events) ──

interface AgentEventPayload {
  process_id: string;
  process_name: string;
  resource_id: string;
  source: string;
  payload: Record<string, unknown> | null;
}

interface EventEmitter {
  emit(event: AgentEventPayload): void;
}

export interface EmitterDeps {
  store: CredentialStore;
  emitter: EventEmitter;
  processId: string;
  processName: string;
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface UpstreamResult {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_BODY_BYTES = 10 * 1024 * 1024; // 10 MB
const MAX_RESPONSE_BYTES = 50 * 1024 * 1024; // 50 MB — prevents OOM from unbounded upstream responses
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── Exported helpers ──────────────────────────────────────────────────────────

export async function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalSize = 0;
    let settled = false;

    const timer = setTimeout(() => {
      fail(new Error("Request body read timed out"));
      req.destroy();
    }, 30_000);

    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    };

    req.on("data", (chunk: Buffer) => {
      if (settled) return;
      totalSize += chunk.length;
      if (totalSize > MAX_BODY_BYTES) {
        req.destroy();
        fail(new Error("Request body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(Buffer.concat(chunks));
    });
    req.on("error", fail);
  });
}

export function isLocalhost(req: IncomingMessage): boolean {
  const remoteAddr = req.socket.remoteAddress ?? "";
  return (
    remoteAddr === "127.0.0.1" ||
    remoteAddr === "::1" ||
    remoteAddr === "::ffff:127.0.0.1"
  );
}

export async function handleProxy(
  req: IncomingMessage,
  res: ServerResponse,
  deps: EmitterDeps
): Promise<void> {
  let targetUrl = req.headers["x-target-url"] as string | undefined;

  // Fall back to ?url= query parameter for compatibility with criterion-style test commands.
  if (!targetUrl && req.url) {
    const parsedReqUrl = new URL(req.url, "http://localhost");
    const urlParam = parsedReqUrl.searchParams.get("url");
    if (urlParam) {
      targetUrl = urlParam;
    }
  }

  if (!targetUrl) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Missing target URL (provide X-Target-URL header or ?url= query parameter)" }));
    return;
  }

  // Validate URL is parseable before proceeding.
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(targetUrl);
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Invalid X-Target-URL" }));
    return;
  }

  // SSRF guard at the connection level — block before any outbound attempt.
  // resolveCredentials() also checks, but only for credential injection.
  // This ensures the proxy never forwards requests to private/loopback IPs
  // even without credential injection (prevents internal network probing).
  const ssrfBlocked = await isBlockedBySSRF(parsedUrl.hostname);
  if (ssrfBlocked) {
    res.writeHead(403, { "Content-Type": "application/json", "x-credential-injected": "false" });
    res.end(JSON.stringify({ error: "Forbidden: SSRF protection" }));
    return;
  }

  const xResource = req.headers["x-resource"] as string | undefined;

  // Resolve credentials.
  const { injectHeaders, queryParam, oauthCredentials, proxyUrlEnvVar, proxyUrl, resourceId } = await resolveCredentials(targetUrl, xResource, {
    store: deps.store,
  });

  // For query-param injection, append the secret as a URL parameter.
  if (queryParam) {
    parsedUrl.searchParams.set(queryParam.name, queryParam.value);
    targetUrl = parsedUrl.toString();
  }

  // If the resource declared a proxyResourceId but we couldn't resolve the proxy URL, fail loudly.
  // Do not include the env var name in the response — prevents enumeration of internal config.
  if (proxyUrlEnvVar && !proxyUrl) {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Proxy URL not resolved' }));
    return;
  }

  // Build outbound headers: start from request headers, strip sensitive ones.
  const outboundHeaders: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    const lowerKey = key.toLowerCase();
    // Strip hop-by-hop and proxy-specific headers.
    if (
      lowerKey === "x-target-url" ||
      lowerKey === "x-resource" ||
      lowerKey === "host" ||
      lowerKey === "connection" ||
      lowerKey === "transfer-encoding" ||
      lowerKey === "te" ||
      lowerKey === "upgrade" ||
      lowerKey === "proxy-connection" ||
      // Strip caller-supplied auth headers — the proxy is the sole source of credentials.
      // If no credentials are resolved, no auth should be forwarded.
      lowerKey === "authorization" ||
      lowerKey === "apikey" ||
      // Strip internal proxy headers — must not leak to upstream third-party servers.
      lowerKey === "x-process-id" ||
      // Strip content-length — it will be recalculated from the actual body.
      // Without this, oauth2-refresh body merging sends stale content-length
      // causing upstream servers to hang or misparse the request.
      lowerKey === "content-length"
    ) {
      continue;
    }
    if (typeof value === "string") {
      outboundHeaders[key] = value;
    } else if (Array.isArray(value)) {
      outboundHeaders[key] = value.join(", ");
    }
  }

  // Inject credentials (may override existing Authorization header).
  for (const [key, value] of Object.entries(injectHeaders)) {
    outboundHeaders[key] = value;
  }

  // Set correct Host for the upstream.
  outboundHeaders["host"] = parsedUrl.host;

  // Read request body.
  let body = await readBody(req);
  let hasBody = body.length > 0 && req.method !== "GET" && req.method !== "HEAD";

  // For oauth2-refresh injection, merge client_id/client_secret/refresh_token into the form body.
  if (oauthCredentials) {
    const bodyStr = body.toString("utf-8");
    const params = new URLSearchParams(bodyStr);
    params.set("client_id", oauthCredentials.client_id);
    params.set("client_secret", oauthCredentials.client_secret);
    params.set("refresh_token", oauthCredentials.refresh_token);
    const mergedBody = params.toString();
    body = Buffer.from(mergedBody, "utf-8");
    outboundHeaders["content-type"] = "application/x-www-form-urlencoded";
    hasBody = true;
  }

  // Set accurate content-length from the final body buffer.
  // The original content-length was stripped above; here we restore it
  // from the actual bytes being sent (which may have been modified by
  // oauth2-refresh merging). This is required for the SOCKS5 path
  // (https.request) which does not auto-calculate content-length.
  if (hasBody) {
    outboundHeaders["content-length"] = String(body.length);
  }

  // Forward to upstream — no redirect following.
  // When a SOCKS5 proxy is configured, use the Node https module (which supports
  // the agent option). Node's native fetch is undici-based and ignores the agent
  // option, so it cannot route through a SocksProxyAgent.
  // Without a proxy, use native fetch to preserve the interceptor-bypass behavior.

  let upstream: UpstreamResult;
  const usedSocksProxy = !!proxyUrl;

  try {
    if (proxyUrl) {
      // Validate proxy URL scheme before constructing the agent.
      // Reject socks5h:// — it delegates DNS resolution to the proxy server,
      // bypassing our local SSRF guard (DNS rebinding risk).
      if (proxyUrl.startsWith("socks5h://")) {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Proxy URL is not a valid SOCKS URL" }));
        return;
      }
      if (!proxyUrl.startsWith("socks5://") && !proxyUrl.startsWith("socks4://")) {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Proxy URL is not a valid SOCKS URL" }));
        return;
      }

      // Reject non-HTTPS targets on the SOCKS path — https.request assumes TLS.
      if (parsedUrl.protocol !== "https:") {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Only HTTPS targets are supported via SOCKS proxy" }));
        return;
      }

      // SOCKS5 path — use Node https module with SocksProxyAgent.
      // Request uncompressed responses: https.request doesn't auto-decompress,
      // and we strip content-encoding in the response headers uniformly.
      outboundHeaders["accept-encoding"] = "identity";
      const agent = new SocksProxyAgent(proxyUrl);
      upstream = await new Promise<UpstreamResult>((resolve, reject) => {
        const reqOptions: https.RequestOptions = {
          method: req.method ?? "GET",
          hostname: parsedUrl.hostname,
          port: parsedUrl.port || 443,
          path: parsedUrl.pathname + parsedUrl.search,
          headers: outboundHeaders,
          agent,
          timeout: 30_000,
        };
        const proxyReq = https.request(reqOptions, (proxyRes) => {
          const chunks: Buffer[] = [];
          let totalResponseSize = 0;
          let aborted = false;
          proxyRes.on("data", (chunk: Buffer) => {
            totalResponseSize += chunk.length;
            if (totalResponseSize > MAX_RESPONSE_BYTES) {
              aborted = true;
              proxyReq.destroy(new Error("Response body too large"));
              return;
            }
            chunks.push(chunk);
          });
          proxyRes.on("end", () => {
            if (aborted) {
              reject(new Error("Response body too large"));
              return;
            }
            const resHeaders: Record<string, string> = {};
            for (const [k, v] of Object.entries(proxyRes.headers)) {
              if (typeof v === "string") resHeaders[k] = v;
              else if (Array.isArray(v)) resHeaders[k] = v.join(", ");
            }
            resolve({
              status: proxyRes.statusCode ?? 200,
              headers: resHeaders,
              body: Buffer.concat(chunks),
            });
          });
          proxyRes.on("error", reject);
        });
        proxyReq.on("timeout", () => {
          proxyReq.destroy(new Error("SOCKS5 proxy request timed out"));
        });
        proxyReq.on("error", reject);
        if (hasBody) proxyReq.write(body);
        proxyReq.end();
      });
    } else {
      // Direct path — use native fetch (bypasses interceptor if patched).
      const nativeFetch = getNativeFetch();
      const fetchResponse = await nativeFetch(targetUrl, {
        method: req.method ?? "GET",
        headers: outboundHeaders,
        body: hasBody ? new Uint8Array(body) : undefined,
        redirect: "manual",
        signal: AbortSignal.timeout(30_000),
      });
      const resHeaders: Record<string, string> = {};
      fetchResponse.headers.forEach((v, k) => { resHeaders[k] = v; });
      // Pre-check Content-Length to reject obviously oversized responses before buffering.
      const clHeader = fetchResponse.headers.get("content-length");
      if (clHeader && parseInt(clHeader, 10) > MAX_RESPONSE_BYTES) {
        throw new Error("Response body too large");
      }
      const bodyBuf = Buffer.from(await fetchResponse.arrayBuffer());
      if (bodyBuf.length > MAX_RESPONSE_BYTES) {
        throw new Error("Response body too large");
      }
      upstream = { status: fetchResponse.status, headers: resHeaders, body: bodyBuf };
    }
  } catch (err) {
    // Network error — return 502.
    // Log path only (not query string) to avoid logging injected credentials.
    logger.error('Upstream error', err instanceof Error ? err : { error: String(err), url: `${parsedUrl.origin}${parsedUrl.pathname}` });
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Upstream connection failed" }));
    return;
  }

  // Build response headers — strip hop-by-hop and unsafe headers.
  const responseHeaders: Record<string, string> = {};
  for (const [key, value] of Object.entries(upstream.headers)) {
    const lowerKey = key.toLowerCase();
    // Strip Location from redirected responses — never reflect to agent.
    if (lowerKey === "location") continue;
    // Strip encoding headers on both paths:
    // - fetch() auto-decompresses, so content-encoding would cause double-decompression.
    // - https.request does NOT auto-decompress, but we buffer the full body via
    //   Buffer.concat and forward it without decompression. To avoid mismatches,
    //   we request identity encoding on the SOCKS path (see outboundHeaders below)
    //   and strip these headers uniformly.
    if (lowerKey === "content-encoding") continue;
    if (lowerKey === "transfer-encoding") continue;
    responseHeaders[key] = value;
  }

  // Set accurate content-length from the buffered body. The original content-length
  // may be stale (e.g. fetch auto-decompressed, changing the size).
  responseHeaders["content-length"] = String(upstream.body.length);

  // Add proxy attestation header — lets callers verify the request
  // actually passed through the credential proxy (useful in tests).
  const credentialsInjected = Object.keys(injectHeaders).length > 0 || !!queryParam || !!oauthCredentials;
  responseHeaders["x-proxied-by"] = "credential-proxy";
  responseHeaders["x-credential-injected"] = credentialsInjected ? "true" : "false";

  // Resolve caller-supplied process ID — validate it is a UUID to prevent injection.
  const rawProcessId = req.headers['x-process-id'] as string | undefined;
  const processId = (rawProcessId && UUID_RE.test(rawProcessId)) ? rawProcessId : deps.processId;

  // Emit agent event if a resource was resolved.
  // Fire-and-forget: emit() is void, never awaited, never throws.
  if (resourceId !== undefined) {
    deps.emitter.emit({
      process_id: processId,
      process_name: deps.processName,
      resource_id: resourceId,
      source: 'credential-proxy',
      payload: { targetHost: parsedUrl.hostname, credentialInjected: credentialsInjected },
    });
  }

  // Structured injection log — used by E2E tests to verify the full ontology chain.
  logger.debug('Request proxied', { resource: xResource ?? 'unknown', processId, credentialsInjected });
  // x-resource-resolved intentionally omitted — disclosing the resource name
  // would allow enumeration of the resource registry by callers.

  // Suppress unused variable warning — usedSocksProxy may be used for future logging.
  void usedSocksProxy;

  res.writeHead(upstream.status, responseHeaders);
  res.end(upstream.body);
}

export async function handleAdminCacheInvalidate(
  req: IncomingMessage,
  res: ServerResponse,
  store: CredentialStore
): Promise<void> {
  // Admin endpoint — localhost only, no agent access.
  if (!isLocalhost(req)) {
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Forbidden" }));
    return;
  }

  if (req.method !== "POST") {
    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Method not allowed" }));
    return;
  }

  store.invalidate();
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true, message: "Cache invalidated" }));
}
