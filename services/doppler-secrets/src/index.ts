import { SecretNotFoundError } from "./types.js";
import type { SecretsStore } from "./types.js";

export type { SecretsStore, KVFallback, DopplerSecretsOptions } from "./types.js";
export { DopplerUnavailableError, SecretNotFoundError } from "./types.js";
export { createSecretsStore } from "./store.js";

export function createStaticStore(secrets: Record<string, string>): SecretsStore {
  return {
    get(key: string): string {
      const val = secrets[key];
      if (val === undefined) throw new SecretNotFoundError(key);
      return val;
    },
    getOptional(key: string): string | undefined {
      return secrets[key];
    },
  };
}
