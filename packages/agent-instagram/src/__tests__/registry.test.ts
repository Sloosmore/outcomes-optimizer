import type { InstagramAdapter, InstagramSession, InstagramCredentials, SessionState } from "../adapters/types.js";

/**
 * Create a fresh registry for each test (not the singleton)
 */
class TestAdapterRegistry {
  private adapters = new Map<string, {
    adapter: InstagramAdapter;
    description: string;
    requiresAuth: boolean;
    ciCompatible: boolean;
  }>();

  register(name: string, info: {
    adapter: InstagramAdapter;
    description: string;
    requiresAuth: boolean;
    ciCompatible: boolean;
  }): void {
    if (this.adapters.has(name)) {
      throw new Error(`Adapter "${name}" is already registered`);
    }
    this.adapters.set(name, info);
  }

  getInfo(name: string) {
    return this.adapters.get(name);
  }

  get(name: string): InstagramAdapter {
    const info = this.adapters.get(name);
    if (!info) {
      const available = this.list().join(", ");
      throw new Error(`Unknown adapter: "${name}". Available: ${available}`);
    }
    return info.adapter;
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

/**
 * Create a mock adapter for testing
 */
function createMockAdapter(name: string): InstagramAdapter {
  return {
    name,
    createSession: vi.fn(async (credentials: InstagramCredentials) => {
      return {
        accountId: credentials.businessAccountId,
        username: "testuser",
        credentials: {
          accessToken: credentials.accessToken,
          businessAccountId: credentials.businessAccountId,
          username: "testuser",
          created: new Date().toISOString(),
          adapter: name,
        },
        postPhoto: vi.fn(),
        postVideo: vi.fn(),
        postReel: vi.fn(),
        getPostStatus: vi.fn(),
        getProfile: vi.fn(),
      } as unknown as InstagramSession;
    }),
    restoreSession: vi.fn((savedState: SessionState) => {
      return {
        accountId: savedState.businessAccountId,
        username: savedState.username,
        credentials: savedState,
        postPhoto: vi.fn(),
        postVideo: vi.fn(),
        postReel: vi.fn(),
        getPostStatus: vi.fn(),
        getProfile: vi.fn(),
      } as unknown as InstagramSession;
    }),
  };
}

describe("AdapterRegistry", () => {
  let registry: TestAdapterRegistry;

  beforeEach(() => {
    registry = new TestAdapterRegistry();
  });

  describe("register", () => {
    it("should register a new adapter", () => {
      const adapter = createMockAdapter("test");

      registry.register("test", {
        adapter,
        description: "Test adapter",
        requiresAuth: true,
        ciCompatible: true,
      });

      expect(registry.has("test")).toBe(true);
    });

    it("should throw if adapter already registered", () => {
      const adapter = createMockAdapter("test");

      registry.register("test", {
        adapter,
        description: "Test adapter",
        requiresAuth: true,
        ciCompatible: true,
      });

      expect(() => {
        registry.register("test", {
          adapter,
          description: "Duplicate",
          requiresAuth: true,
          ciCompatible: true,
        });
      }).toThrow('Adapter "test" is already registered');
    });
  });

  describe("get", () => {
    it("should return adapter instance", () => {
      const adapter = createMockAdapter("test");

      registry.register("test", {
        adapter,
        description: "Test adapter",
        requiresAuth: true,
        ciCompatible: false,
      });

      const result = registry.get("test");
      expect(result.name).toBe("test");
    });

    it("should throw for unknown adapter", () => {
      registry.register("known", {
        adapter: createMockAdapter("known"),
        description: "Known adapter",
        requiresAuth: true,
        ciCompatible: true,
      });

      expect(() => registry.get("unknown")).toThrow(
        'Unknown adapter: "unknown". Available: known'
      );
    });
  });

  describe("getInfo", () => {
    it("should return adapter info", () => {
      registry.register("test", {
        adapter: createMockAdapter("test"),
        description: "Test adapter",
        requiresAuth: true,
        ciCompatible: false,
      });

      const info = registry.getInfo("test");
      expect(info).toBeDefined();
      expect(info?.description).toBe("Test adapter");
      expect(info?.requiresAuth).toBe(true);
      expect(info?.ciCompatible).toBe(false);
    });

    it("should return undefined for unknown adapter", () => {
      expect(registry.getInfo("unknown")).toBeUndefined();
    });
  });

  describe("has", () => {
    it("should return true for registered adapter", () => {
      registry.register("test", {
        adapter: createMockAdapter("test"),
        description: "Test",
        requiresAuth: true,
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
        adapter: createMockAdapter("alpha"),
        description: "Alpha",
        requiresAuth: true,
        ciCompatible: true,
      });
      registry.register("beta", {
        adapter: createMockAdapter("beta"),
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
        adapter: createMockAdapter("test"),
        description: "Test",
        requiresAuth: true,
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
        adapter: createMockAdapter("first"),
        description: "First",
        requiresAuth: true,
        ciCompatible: true,
      });
      registry.register("second", {
        adapter: createMockAdapter("second"),
        description: "Second",
        requiresAuth: true,
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
  it("should have instagram-api registered", async () => {
    const { adapterRegistry } = await import("../adapters/index.js");

    expect(adapterRegistry.has("instagram-api")).toBe(true);
    const info = adapterRegistry.getInfo("instagram-api");
    expect(info?.requiresAuth).toBe(true);
    expect(info?.ciCompatible).toBe(false);
  });

  it("should get instagram-api adapter", async () => {
    const { adapterRegistry } = await import("../adapters/index.js");

    const adapter = adapterRegistry.get("instagram-api");
    expect(adapter.name).toBe("instagram-api");
  });

  it("should restore session from saved state", async () => {
    const { adapterRegistry } = await import("../adapters/index.js");

    const savedState: SessionState = {
      accessToken: "test-token-123",
      businessAccountId: "123456789",
      username: "testuser",
      created: new Date().toISOString(),
      adapter: "instagram-api",
    };

    const adapter = adapterRegistry.get("instagram-api");
    const session = adapter.restoreSession(savedState);
    expect(session.accountId).toBe("123456789");
    expect(session.username).toBe("testuser");
  });
});
