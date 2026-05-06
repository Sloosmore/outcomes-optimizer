import type { SecretsStore, DopplerSecretsOptions } from "./types.js";
import { DopplerUnavailableError, SecretNotFoundError } from "./types.js";
import { fetchDopplerSecrets } from "./doppler.js";

const KV_KEY = "doppler:secrets";
const DEFAULT_TTL = 300;

export async function createSecretsStore(
  options: DopplerSecretsOptions
): Promise<SecretsStore> {
  const { serviceToken, project, config, fallback } = options;
  const ttlSeconds = options.ttlSeconds ?? DEFAULT_TTL;

  let cache: Record<string, string> = {};
  let expiresAt = 0;
  let refreshPromise: Promise<void> | null = null;

  async function doRefresh(): Promise<void> {
    // 1. Try Doppler
    try {
      const secrets = await fetchDopplerSecrets(serviceToken, project, config);
      cache = secrets;
      expiresAt = Date.now() + ttlSeconds * 1000;
      if (fallback) {
        await fallback
          .put(KV_KEY, JSON.stringify(secrets), {
            expirationTtl: ttlSeconds * 4,
          })
          .catch(() => {
            // KV write failure is non-fatal
          });
      }
      return;
    } catch (dopplerErr) {
      // 2. Try KV fallback
      if (fallback) {
        const raw = await fallback.get(KV_KEY).catch(() => null);
        if (raw !== null) {
          cache = JSON.parse(raw) as Record<string, string>;
          expiresAt = Date.now() + ttlSeconds * 1000;
          return;
        }
      }
      // 3. Both failed
      throw dopplerErr instanceof DopplerUnavailableError
        ? dopplerErr
        : new DopplerUnavailableError("Doppler unavailable and no KV fallback", dopplerErr);
    }
  }

  function scheduleRefresh(): Promise<void> {
    if (!refreshPromise) {
      refreshPromise = doRefresh().finally(() => {
        refreshPromise = null;
      });
    }
    return refreshPromise;
  }

  async function ensureFresh(): Promise<void> {
    if (Date.now() < expiresAt) return;
    await scheduleRefresh();
  }

  // Cold start: initial fetch
  await ensureFresh();

  function backgroundRefresh(): void {
    ensureFresh().catch(() => {
      // Background refresh failure is non-fatal — stale cache continues to serve.
      // Errors will surface on the next cold-start or explicit await.
    });
  }

  return {
    get(key: string): string {
      backgroundRefresh();
      const val = cache[key];
      if (val === undefined) throw new SecretNotFoundError(key);
      return val;
    },
    getOptional(key: string): string | undefined {
      backgroundRefresh();
      return cache[key];
    },
  };
}
