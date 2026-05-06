export interface SecretsStore {
  get(key: string): string;
  getOptional(key: string): string | undefined;
}

export interface KVFallback {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

export interface DopplerSecretsOptions {
  serviceToken: string;
  project: string;
  config: string;
  ttlSeconds?: number;
  fallback?: KVFallback;
}

export class DopplerUnavailableError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "DopplerUnavailableError";
  }
}

export class SecretNotFoundError extends Error {
  constructor(key: string) {
    super(`Secret "${key}" not found in Doppler config`);
    this.name = "SecretNotFoundError";
  }
}
