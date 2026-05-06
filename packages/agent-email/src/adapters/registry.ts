import type { EmailAdapter } from "./types.js";

/**
 * Adapter metadata for registration
 */
export interface AdapterInfo {
  /** The adapter instance (stateless factory) */
  adapter: EmailAdapter;
  /** Human-readable description */
  description: string;
  /** Whether this adapter requires authentication/credentials */
  requiresAuth: boolean;
  /** Whether this adapter works in CI/cloud environments */
  ciCompatible: boolean;
}

/**
 * Registry for email adapters
 *
 * Adapters are stateless factories that create sessions.
 * Sessions hold the connection state.
 *
 * Usage:
 *   registry.register("gmail", {
 *     adapter: new GmailAdapter(),
 *     description: "Gmail via OAuth",
 *     requiresAuth: true,
 *     ciCompatible: true,
 *   });
 *
 *   const adapter = registry.get("gmail");
 *   const session = await adapter.createSession();
 */
class AdapterRegistry {
  private adapters = new Map<string, AdapterInfo>();

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
   * Get adapter info by name
   */
  getInfo(name: string): AdapterInfo | undefined {
    return this.adapters.get(name);
  }

  /**
   * Get an adapter instance by name
   */
  get(name: string): EmailAdapter {
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
   * Get all adapters with their metadata
   */
  all(): Map<string, AdapterInfo> {
    return new Map(this.adapters);
  }

  /**
   * Get the default adapter name
   */
  getDefault(): string {
    // Return first registered adapter as default
    const first = this.adapters.keys().next().value;
    if (!first) {
      throw new Error("No adapters registered");
    }
    return first;
  }
}

// Export singleton instance
export const adapterRegistry = new AdapterRegistry();
