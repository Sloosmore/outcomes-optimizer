import type { MediaAdapter } from "./types.js";
import type { Modality } from "../config.js";

/**
 * Adapter metadata for registration
 */
export interface AdapterInfo {
  /** The adapter instance */
  adapter: MediaAdapter;
  /** Human-readable description */
  description: string;
  /** Whether this adapter requires API keys */
  requiresAuth: boolean;
  /** Environment variable(s) needed for auth (ANY one is sufficient) */
  authEnvVars?: string[];
  /** Whether this adapter works in CI (has mock mode) */
  ciCompatible: boolean;
}

/**
 * Registry for media adapters
 *
 * Single registry with modality filtering.
 * Adapters declare which modalities they support.
 *
 * Usage:
 *   registry.register("openai", {
 *     adapter: new OpenAIAdapter(),
 *     description: "OpenAI DALL-E and TTS",
 *     requiresAuth: true,
 *     authEnvVars: ["OPENAI_API_KEY"],
 *     ciCompatible: false,
 *   });
 *
 *   const adapter = registry.get("openai");
 *   const images = await adapter.generateImage("a cat");
 */
class AdapterRegistry {
  private adapters = new Map<string, AdapterInfo>();
  private defaults = new Map<Modality, string>();

  /**
   * Register a new adapter
   */
  register(name: string, info: AdapterInfo): void {
    if (this.adapters.has(name)) {
      throw new Error(`Adapter "${name}" is already registered`);
    }
    this.adapters.set(name, info);
  }

  /**
   * Set the default adapter for a modality
   */
  setDefault(modality: Modality, adapterName: string): void {
    if (!this.adapters.has(adapterName)) {
      throw new Error(`Cannot set default: adapter "${adapterName}" not registered`);
    }
    const adapter = this.adapters.get(adapterName)!.adapter;
    if (!adapter.capabilities.modalities.includes(modality)) {
      throw new Error(
        `Adapter "${adapterName}" does not support ${modality}`
      );
    }
    this.defaults.set(modality, adapterName);
  }

  /**
   * Get adapter info by name
   */
  getInfo(name: string): AdapterInfo | undefined {
    return this.adapters.get(name);
  }

  /**
   * Get an adapter instance by name
   */
  get(name: string): MediaAdapter {
    const info = this.adapters.get(name);
    if (!info) {
      const available = this.list().join(", ");
      throw new Error(`Unknown adapter: "${name}". Available: ${available}`);
    }
    return info.adapter;
  }

  /**
   * Check if an adapter is registered
   */
  has(name: string): boolean {
    return this.adapters.has(name);
  }

  /**
   * List all registered adapter names
   */
  list(): string[] {
    return Array.from(this.adapters.keys());
  }

  /**
   * List adapters that support a specific modality
   */
  listByModality(modality: Modality): string[] {
    return Array.from(this.adapters.entries())
      .filter(([_, info]) =>
        info.adapter.capabilities.modalities.includes(modality)
      )
      .map(([name]) => name);
  }

  /**
   * Get all adapters with their metadata
   */
  all(): Map<string, AdapterInfo> {
    return new Map(this.adapters);
  }

  /**
   * Get the default adapter for a modality
   */
  getDefault(modality: Modality): string {
    // Check explicit default first
    const explicit = this.defaults.get(modality);
    if (explicit) return explicit;

    // Fall back to first adapter supporting this modality
    const adapters = this.listByModality(modality);
    if (adapters.length === 0) {
      throw new Error(`No adapters registered for ${modality}`);
    }
    return adapters[0];
  }

  /**
   * Check if required environment variables are set for an adapter
   * Returns ok=true if ANY of the authEnvVars is set (not ALL)
   */
  checkAuth(name: string): { ok: boolean; missing: string[] } {
    const info = this.adapters.get(name);
    if (!info) {
      return { ok: false, missing: [] };
    }
    if (!info.requiresAuth || !info.authEnvVars) {
      return { ok: true, missing: [] };
    }
    // Check if ANY env var is set (not ALL)
    const hasAny = info.authEnvVars.some((v) => !!process.env[v]);
    return {
      ok: hasAny,
      missing: hasAny ? [] : info.authEnvVars,
    };
  }
}

// Export singleton instance
export const adapterRegistry = new AdapterRegistry();
