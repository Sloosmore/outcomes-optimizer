import { describe, it, expect, beforeEach } from "vitest";

// Create a fresh registry for testing (not the singleton)
class TestAdapterRegistry {
  private adapters = new Map<string, { adapter: any; description: string }>();
  private defaults = new Map<string, string>();

  register(name: string, info: { adapter: any; description: string }) {
    this.adapters.set(name, info);
  }

  setDefault(modality: string, name: string) {
    this.defaults.set(modality, name);
  }

  get(name: string) {
    const info = this.adapters.get(name);
    if (!info) throw new Error(`Unknown adapter: ${name}`);
    return info.adapter;
  }

  has(name: string) {
    return this.adapters.has(name);
  }

  list() {
    return Array.from(this.adapters.keys());
  }

  getDefault(modality: string) {
    return this.defaults.get(modality) || this.list()[0];
  }
}

describe("AdapterRegistry", () => {
  let registry: TestAdapterRegistry;

  beforeEach(() => {
    registry = new TestAdapterRegistry();
  });

  it("should register and retrieve adapters", () => {
    const mockAdapter = { name: "test", capabilities: { modalities: ["image"] } };
    registry.register("test", { adapter: mockAdapter, description: "Test adapter" });

    expect(registry.has("test")).toBe(true);
    expect(registry.get("test")).toBe(mockAdapter);
  });

  it("should list registered adapters", () => {
    registry.register("a", { adapter: {}, description: "A" });
    registry.register("b", { adapter: {}, description: "B" });

    expect(registry.list()).toEqual(["a", "b"]);
  });

  it("should throw on unknown adapter", () => {
    expect(() => registry.get("unknown")).toThrow("Unknown adapter");
  });

  it("should support default adapters per modality", () => {
    registry.register("openai", { adapter: {}, description: "OpenAI" });
    registry.register("google", { adapter: {}, description: "Google" });
    registry.setDefault("image", "openai");
    registry.setDefault("video", "google");

    expect(registry.getDefault("image")).toBe("openai");
    expect(registry.getDefault("video")).toBe("google");
  });
});
