/**
 * Registry for read adapters — AI-powered media understanding
 *
 * Mirrors the AdapterRegistry pattern but typed to ReadAdapter.
 * Gemini is registered as the default.
 */

import type { ReadAdapter } from "./read-types.js";
import { GeminiReadAdapter } from "./gemini-read.js";

class ReadAdapterRegistry {
  private adapters = new Map<string, ReadAdapter>();
  private defaultName: string | undefined;

  register(name: string, adapter: ReadAdapter): void {
    if (this.adapters.has(name)) {
      throw new Error(`Read adapter "${name}" is already registered`);
    }
    this.adapters.set(name, adapter);
  }

  get(name: string): ReadAdapter {
    const adapter = this.adapters.get(name);
    if (!adapter) {
      const available = Array.from(this.adapters.keys()).join(", ");
      throw new Error(`Unknown read adapter: "${name}". Available: ${available}`);
    }
    return adapter;
  }

  getDefault(): ReadAdapter {
    if (!this.defaultName) {
      const first = this.adapters.keys().next().value;
      if (!first) {
        throw new Error("No read adapters registered");
      }
      return this.adapters.get(first)!;
    }
    return this.get(this.defaultName);
  }

  setDefault(name: string): void {
    if (!this.adapters.has(name)) {
      throw new Error(`Cannot set default: read adapter "${name}" not registered`);
    }
    this.defaultName = name;
  }

  list(): string[] {
    return Array.from(this.adapters.keys());
  }
}

// Singleton with gemini registered as default
export const readRegistry = new ReadAdapterRegistry();

readRegistry.register("gemini", new GeminiReadAdapter());
readRegistry.setDefault("gemini");
