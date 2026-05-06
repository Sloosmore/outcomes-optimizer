// Create a fresh registry for each test (not the singleton)
class TestAdapterRegistry {
  private adapters = new Map<string, {
    factory: (state?: unknown) => { name: string };
    description: string;
    requiresAuth: boolean;
    ciCompatible: boolean;
  }>();

  register(name: string, info: {
    factory: (state?: unknown) => { name: string };
    description: string;
    requiresAuth: boolean;
    ciCompatible: boolean;
  }): void {
    if (this.adapters.has(name)) {
      throw new Error(`Adapter "${name}" is already registered`);
    }
    this.adapters.set(name, info);
  }

  get(name: string) {
    return this.adapters.get(name);
  }

  create(name: string, state?: unknown) {
    const info = this.adapters.get(name);
    if (!info) {
      const available = this.list().join(", ");
      throw new Error(`Unknown adapter: "${name}". Available: ${available}`);
    }
    return info.factory(state);
  }

  has(name: string): boolean {
    return this.adapters.has(name);
  }

  list(): string[] {
    return Array.from(this.adapters.keys());
  }

  all() {
    return new Map(this.adapters);
  }

  getDefault(): string {
    const first = this.adapters.keys().next().value;
    if (!first) {
      throw new Error("No adapters registered");
    }
    return first;
  }
}

describe("AdapterRegistry", () => {
  let registry: TestAdapterRegistry;

  beforeEach(() => {
    registry = new TestAdapterRegistry();
  });

  describe("register", () => {
    it("should register a new adapter", () => {
      const factory = vi.fn(() => ({ name: "test" }));

      registry.register("test", {
        factory,
        description: "Test adapter",
        requiresAuth: false,
        ciCompatible: true,
      });

      expect(registry.has("test")).toBe(true);
    });

    it("should throw if adapter already registered", () => {
      const factory = vi.fn(() => ({ name: "test" }));

      registry.register("test", {
        factory,
        description: "Test adapter",
        requiresAuth: false,
        ciCompatible: true,
      });

      expect(() => {
        registry.register("test", {
          factory,
          description: "Duplicate",
          requiresAuth: false,
          ciCompatible: true,
        });
      }).toThrow('Adapter "test" is already registered');
    });
  });

  describe("get", () => {
    it("should return adapter info", () => {
      const factory = vi.fn(() => ({ name: "test" }));

      registry.register("test", {
        factory,
        description: "Test adapter",
        requiresAuth: true,
        ciCompatible: false,
      });

      const info = registry.get("test");
      expect(info).toBeDefined();
      expect(info?.description).toBe("Test adapter");
      expect(info?.requiresAuth).toBe(true);
      expect(info?.ciCompatible).toBe(false);
    });

    it("should return undefined for unknown adapter", () => {
      expect(registry.get("unknown")).toBeUndefined();
    });
  });

  describe("create", () => {
    it("should create adapter instance", () => {
      const factory = vi.fn(() => ({ name: "test" }));

      registry.register("test", {
        factory,
        description: "Test adapter",
        requiresAuth: false,
        ciCompatible: true,
      });

      const adapter = registry.create("test");
      expect(adapter.name).toBe("test");
      expect(factory).toHaveBeenCalled();
    });

    it("should pass state to factory", () => {
      const factory = vi.fn((state) => ({ name: "test", state }));

      registry.register("test", {
        factory,
        description: "Test adapter",
        requiresAuth: true,
        ciCompatible: true,
      });

      const state = { credentials: { token: "abc123" } };
      registry.create("test", state);

      expect(factory).toHaveBeenCalledWith(state);
    });

    it("should throw for unknown adapter", () => {
      registry.register("known", {
        factory: () => ({ name: "known" }),
        description: "Known adapter",
        requiresAuth: false,
        ciCompatible: true,
      });

      expect(() => registry.create("unknown")).toThrow(
        'Unknown adapter: "unknown". Available: known'
      );
    });
  });

  describe("has", () => {
    it("should return true for registered adapter", () => {
      registry.register("test", {
        factory: () => ({ name: "test" }),
        description: "Test",
        requiresAuth: false,
        ciCompatible: true,
      });

      expect(registry.has("test")).toBe(true);
    });

    it("should return false for unregistered adapter", () => {
      expect(registry.has("unknown")).toBe(false);
    });
  });

  describe("list", () => {
    it("should return empty array when no adapters", () => {
      expect(registry.list()).toEqual([]);
    });

    it("should return all registered adapter names", () => {
      registry.register("alpha", {
        factory: () => ({ name: "alpha" }),
        description: "Alpha",
        requiresAuth: false,
        ciCompatible: true,
      });
      registry.register("beta", {
        factory: () => ({ name: "beta" }),
        description: "Beta",
        requiresAuth: true,
        ciCompatible: false,
      });

      expect(registry.list()).toEqual(["alpha", "beta"]);
    });
  });

  describe("all", () => {
    it("should return all adapters with metadata", () => {
      registry.register("test", {
        factory: () => ({ name: "test" }),
        description: "Test",
        requiresAuth: false,
        ciCompatible: true,
      });

      const all = registry.all();
      expect(all.size).toBe(1);
      expect(all.get("test")?.description).toBe("Test");
    });
  });

  describe("getDefault", () => {
    it("should return first registered adapter", () => {
      registry.register("first", {
        factory: () => ({ name: "first" }),
        description: "First",
        requiresAuth: false,
        ciCompatible: true,
      });
      registry.register("second", {
        factory: () => ({ name: "second" }),
        description: "Second",
        requiresAuth: false,
        ciCompatible: true,
      });

      expect(registry.getDefault()).toBe("first");
    });

    it("should throw when no adapters registered", () => {
      expect(() => registry.getDefault()).toThrow("No adapters registered");
    });
  });
});

describe("Built-in adapter registration", () => {
  it("should have 1secmail registered", async () => {
    // Import the real registry after built-in adapters are registered
    const { adapterRegistry } = await import("../adapters/index.js");

    expect(adapterRegistry.has("1secmail")).toBe(true);
    const info = adapterRegistry.getInfo("1secmail");
    expect(info?.requiresAuth).toBe(false);
    expect(info?.ciCompatible).toBe(false);
  });

  it("should have mailtm registered", async () => {
    const { adapterRegistry } = await import("../adapters/index.js");

    expect(adapterRegistry.has("mailtm")).toBe(true);
    const info = adapterRegistry.getInfo("mailtm");
    expect(info?.requiresAuth).toBe(true);
    expect(info?.ciCompatible).toBe(true);
  });

  it("should get 1secmail adapter", async () => {
    const { adapterRegistry } = await import("../adapters/index.js");

    const adapter = adapterRegistry.get("1secmail");
    expect(adapter.name).toBe("1secmail");
  });

  it("should get mailtm adapter", async () => {
    const { adapterRegistry } = await import("../adapters/index.js");

    const adapter = adapterRegistry.get("mailtm");
    expect(adapter.name).toBe("mailtm");
  });

  it("should restore mailtm session from credentials", async () => {
    const { adapterRegistry } = await import("../adapters/index.js");

    const credentials = {
      address: "test@example.com",
      login: "test",
      domain: "example.com",
      token: "test-token-123",
    };

    const adapter = adapterRegistry.get("mailtm");
    const session = adapter.restoreSession(credentials);
    // The session should have the address set
    expect(session.address).toBe("test@example.com");
  });
});
