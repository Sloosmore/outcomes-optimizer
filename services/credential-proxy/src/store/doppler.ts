/**
 * DopplerCredentialStore
 *
 * Fetches secrets from Doppler and caches them in memory with a configurable TTL
 * (default 5 minutes). Cache keys are normalized (lowercase, trimmed) to prevent
 * cache-miss amplification from case variations.
 *
 * Security invariant: only keys in the constructor-supplied `allowedKeys` set may
 * ever be fetched. Any request for a key not on that list is rejected immediately,
 * before touching Doppler, to close the confused-deputy attack.
 */
import { getNativeFetch } from "../native-fetch.js";
import type { CredentialStore } from "./interface.js";

interface CacheEntry {
  value: string;
  expiresAt: number;
}

export interface DopplerStoreOptions {
  /** Doppler service token with read access to the project/config. */
  serviceToken: string;
  /** Doppler project name. */
  project: string;
  /** Doppler config name. */
  config: string;
  /** Cache TTL in milliseconds. Default: 5 minutes. */
  ttlMs?: number;
  /** Allowlist of env var names that may ever be fetched. */
  allowedKeys: ReadonlySet<string>;
}

export class DopplerCredentialStore implements CredentialStore {
  private readonly serviceToken: string;
  private readonly project: string;
  private readonly config: string;
  private readonly ttlMs: number;
  private readonly allowedKeys: ReadonlySet<string>;

  /** Normalized (lowercase) cache. */
  private cache: Map<string, CacheEntry> = new Map();
  /** In-flight fetch promise to prevent stampede. */
  private inflightFetch: Promise<Record<string, string>> | null = null;

  constructor(opts: DopplerStoreOptions) {
    this.serviceToken = opts.serviceToken;
    this.project = opts.project;
    this.config = opts.config;
    this.ttlMs = opts.ttlMs ?? 5 * 60 * 1000;
    this.allowedKeys = opts.allowedKeys;
  }

  async get(key: string): Promise<string> {
    const normalizedKey = key.trim().toUpperCase();

    // Security gate: only serve keys on the allowlist.
    if (!this.allowedKeys.has(normalizedKey) && !this.allowedKeys.has(key)) {
      throw new Error(`Key "${key}" is not on the proxy credential allowlist`);
    }

    const cacheKey = normalizedKey.toLowerCase();
    const now = Date.now();

    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      return cached.value;
    }

    // Fetch all secrets at once (amortize Doppler API calls).
    const secrets = await this.fetchAll();

    // Populate cache for ALL returned keys (amortizes subsequent lookups).
    const expiry = Date.now() + this.ttlMs;
    for (const [k, v] of Object.entries(secrets)) {
      if (typeof v === "string") {
        this.cache.set(k.toLowerCase(), { value: v, expiresAt: expiry });
      }
    }

    const value = secrets[normalizedKey] ?? secrets[key];

    if (value === undefined) {
      throw new Error(
        `Secret "${key}" not found in Doppler project "${this.project}" config "${this.config}"`
      );
    }

    return value;
  }

  invalidate(): void {
    this.cache.clear();
    this.inflightFetch = null;
  }

  private async fetchAll(): Promise<Record<string, string>> {
    // Deduplicate concurrent fetches.
    if (!this.inflightFetch) {
      this.inflightFetch = this.doFetch().finally(() => {
        this.inflightFetch = null;
      });
    }
    return this.inflightFetch;
  }

  private async doFetch(): Promise<Record<string, string>> {
    const url = new URL(
      "https://api.doppler.com/v3/configs/config/secrets/download"
    );
    url.searchParams.set("format", "json");
    url.searchParams.set("project", this.project);
    url.searchParams.set("config", this.config);
    url.searchParams.set("include_dynamic_secrets", "false");

    // Use the unpatched fetch (Node built-in) to avoid routing through the
    // credential-proxy interceptor — the proxy calls Doppler to fetch secrets,
    // not the other way around. Using the intercepted fetch would create a
    // recursive loop if this store is ever instantiated in the same process as
    // the interceptor (e.g. in tests).
    const nativeFetch = getNativeFetch();

    let response: Response;
    try {
      response = await nativeFetch(url.toString(), {
        headers: {
          Authorization: `Bearer ${this.serviceToken}`,
          Accept: "application/json",
        },
      });
    } catch (err) {
      throw new Error(
        `Network error contacting Doppler API: ${(err as Error).message}`
      );
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "(unreadable)");
      throw new Error(
        `Doppler API returned ${response.status}: ${body}`
      );
    }

    return (await response.json()) as Record<string, string>;
  }
}
