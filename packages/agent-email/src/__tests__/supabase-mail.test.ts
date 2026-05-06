import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// We'll import the adapter after mocking fetch
const SUPABASE_URL = "https://example.supabase.co";
const ANON_KEY = "sb_publishable_test_anon_key";

/**
 * Build a minimal mock Response
 */
function mockResponse(data: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    statusText: ok ? "OK" : "Error",
    json: async () => data,
    text: async () => JSON.stringify(data),
  } as unknown as Response;
}

describe("SupabaseMailAdapter", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetAllMocks();
  });

  describe("createSession", () => {
    it("returns address matching *@throwmail.supa pattern", async () => {
      const { SupabaseMailAdapter } = await import("../adapters/supabase-mail.js");
      const adapter = new SupabaseMailAdapter();
      const session = await adapter.createSession();
      expect(session.address).toMatch(/^[a-f0-9]+@throwmail\.supa$/);
    });

    it("sets login to hex portion and domain to throwmail.supa", async () => {
      const { SupabaseMailAdapter } = await import("../adapters/supabase-mail.js");
      const adapter = new SupabaseMailAdapter();
      const session = await adapter.createSession();
      expect(session.domain).toBe("throwmail.supa");
      expect(session.login).toMatch(/^[a-f0-9]+$/);
    });

    it("does not make any network calls on createSession", async () => {
      const { SupabaseMailAdapter } = await import("../adapters/supabase-mail.js");
      const adapter = new SupabaseMailAdapter();
      await adapter.createSession();
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe("restoreSession", () => {
    it("restores session from credentials", async () => {
      const { SupabaseMailAdapter } = await import("../adapters/supabase-mail.js");
      const adapter = new SupabaseMailAdapter();
      const credentials = {
        address: "abc123@throwmail.supa",
        login: "abc123",
        domain: "throwmail.supa",
      };
      const session = adapter.restoreSession(credentials);
      expect(session.address).toBe("abc123@throwmail.supa");
    });
  });

  describe("session.send", () => {
    it("calls Supabase REST API with correct body", async () => {
      fetchMock.mockResolvedValue(mockResponse([], true, 201));

      const { SupabaseMailAdapter } = await import("../adapters/supabase-mail.js");
      const adapter = new SupabaseMailAdapter();
      const session = await adapter.createSession();

      await session.send!("recipient@throwmail.supa", "Hello", "World body");

      expect(fetchMock).toHaveBeenCalledOnce();
      const [url, init] = fetchMock.mock.calls[0];

      expect(url).toBe(`${SUPABASE_URL}/rest/v1/throwmail_messages`);
      expect(init.method).toBe("POST");

      const body = JSON.parse(init.body as string);
      expect(body.to_address).toBe("recipient@throwmail.supa");
      expect(body.from_address).toBe(session.address);
      expect(body.subject).toBe("Hello");
      expect(body.body).toBe("World body");
    });

    it("uses correct Supabase auth headers", async () => {
      fetchMock.mockResolvedValue(mockResponse([], true, 201));

      const { SupabaseMailAdapter } = await import("../adapters/supabase-mail.js");
      const adapter = new SupabaseMailAdapter();
      const session = await adapter.createSession();

      await session.send!("to@throwmail.supa", "Sub", "Bod");

      const [, init] = fetchMock.mock.calls[0];
      expect(init.headers["apikey"]).toBe(ANON_KEY);
      expect(init.headers["Authorization"]).toBe(`Bearer ${ANON_KEY}`);
      expect(init.headers["Content-Type"]).toBe("application/json");
    });

    it("throws on non-2xx response", async () => {
      fetchMock.mockResolvedValue(mockResponse({ message: "Bad Request" }, false, 400));

      const { SupabaseMailAdapter } = await import("../adapters/supabase-mail.js");
      const adapter = new SupabaseMailAdapter();
      const session = await adapter.createSession();

      await expect(session.send!("to@throwmail.supa", "Sub", "Bod")).rejects.toThrow();
    });
  });

  describe("session.list", () => {
    it("queries messages where to_address matches current address", async () => {
      const mockMessages = [
        {
          id: "11111111-1111-1111-1111-111111111111",
          to_address: "abc123@throwmail.supa",
          from_address: "sender@throwmail.supa",
          subject: "Test subject",
          body: "Test body",
          created_at: "2024-01-01T00:00:00Z",
        },
      ];
      fetchMock.mockResolvedValue(mockResponse(mockMessages));

      const { SupabaseMailAdapter } = await import("../adapters/supabase-mail.js");
      const adapter = new SupabaseMailAdapter();
      const credentials = {
        address: "abc123@throwmail.supa",
        login: "abc123",
        domain: "throwmail.supa",
      };
      const session = adapter.restoreSession(credentials);

      const result = await session.list();

      const [url] = fetchMock.mock.calls[0];
      expect(url).toContain("to_address=eq.abc123%40throwmail.supa");
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("11111111-1111-1111-1111-111111111111");
      expect(result[0].from).toBe("sender@throwmail.supa");
      expect(result[0].subject).toBe("Test subject");
    });

    it("returns empty array when no messages", async () => {
      fetchMock.mockResolvedValue(mockResponse([]));

      const { SupabaseMailAdapter } = await import("../adapters/supabase-mail.js");
      const adapter = new SupabaseMailAdapter();
      const session = await adapter.createSession();

      const result = await session.list();
      expect(result).toEqual([]);
    });

    it("respects maxResults limit", async () => {
      const mockMessages = Array.from({ length: 5 }, (_, i) => ({
        id: `00000000-0000-0000-0000-00000000000${i}`,
        to_address: "abc123@throwmail.supa",
        from_address: "sender@throwmail.supa",
        subject: `Subject ${i}`,
        body: `Body ${i}`,
        created_at: "2024-01-01T00:00:00Z",
      }));
      // Mock respects the Supabase limit query param
      fetchMock.mockImplementation(async (url: string) => {
        const limitMatch = url.match(/[?&]limit=(\d+)/);
        const limited = limitMatch ? mockMessages.slice(0, Number(limitMatch[1])) : mockMessages;
        return mockResponse(limited);
      });

      const { SupabaseMailAdapter } = await import("../adapters/supabase-mail.js");
      const adapter = new SupabaseMailAdapter();
      const session = await adapter.createSession();

      const result = await session.list(3);
      expect(result).toHaveLength(3);
    });
  });

  describe("session.read", () => {
    it("returns Email object with correct fields", async () => {
      const mockMsg = {
        id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        to_address: "abc123@throwmail.supa",
        from_address: "sender@throwmail.supa",
        subject: "Read subject",
        body: "Read body",
        created_at: "2024-01-15T10:00:00Z",
      };
      fetchMock.mockResolvedValue(mockResponse([mockMsg]));

      const { SupabaseMailAdapter } = await import("../adapters/supabase-mail.js");
      const adapter = new SupabaseMailAdapter();
      const session = await adapter.createSession();

      const email = await session.read("a1b2c3d4-e5f6-7890-abcd-ef1234567890");

      expect(email.id).toBe("a1b2c3d4-e5f6-7890-abcd-ef1234567890");
      expect(email.from).toBe("sender@throwmail.supa");
      expect(email.subject).toBe("Read subject");
      expect(email.textBody).toBe("Read body");
      expect(email.date).toBe("2024-01-15T10:00:00Z");
      expect(email.htmlBody).toBe("");
      expect(email.attachments).toEqual([]);
    });

    it("throws when message not found", async () => {
      fetchMock.mockResolvedValue(mockResponse([]));

      const { SupabaseMailAdapter } = await import("../adapters/supabase-mail.js");
      const adapter = new SupabaseMailAdapter();
      const session = await adapter.createSession();

      await expect(session.read("deadbeef-dead-beef-dead-beefdeadbeef")).rejects.toThrow();
    });
  });

  describe("adapter properties", () => {
    it("has name 'supabase'", async () => {
      const { SupabaseMailAdapter } = await import("../adapters/supabase-mail.js");
      const adapter = new SupabaseMailAdapter();
      expect(adapter.name).toBe("supabase");
    });

    it("has supportsSend = true", async () => {
      const { SupabaseMailAdapter } = await import("../adapters/supabase-mail.js");
      const adapter = new SupabaseMailAdapter();
      expect(adapter.supportsSend).toBe(true);
    });
  });
});

describe("Dual-inbox simulation", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetAllMocks();
  });

  it("A sends to B, B receives; B replies to A, A receives", async () => {
    const { SupabaseMailAdapter } = await import("../adapters/supabase-mail.js");

    const adapterA = new SupabaseMailAdapter();
    const adapterB = new SupabaseMailAdapter();

    const sessionA = await adapterA.createSession();
    const sessionB = await adapterB.createSession();

    // In-memory message store for simulation
    const messages: Array<{
      id: string;
      to_address: string;
      from_address: string;
      subject: string;
      body: string;
      created_at: string;
    }> = [];

    let msgCounter = 0;

    // Mock fetch to simulate Supabase behavior
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const urlStr = url.toString();

      if (init?.method === "POST") {
        // Insert message
        const body = JSON.parse(init.body as string);
        const msg = {
          id: `00000000-0000-0000-0000-${String(++msgCounter).padStart(12, "0")}`,
          to_address: body.to_address,
          from_address: body.from_address,
          subject: body.subject,
          body: body.body,
          created_at: new Date().toISOString(),
        };
        messages.push(msg);
        return mockResponse([], true, 201);
      } else {
        // Query by id (read a specific message)
        const idParam = urlStr.match(/[?&]id=eq\.([^&]+)/)?.[1];
        if (idParam) {
          const id = decodeURIComponent(idParam);
          return mockResponse(messages.filter((m) => m.id === id));
        }

        // Query messages by to_address (list)
        const toParam = urlStr.match(/to_address=eq\.([^&]+)/)?.[1];
        if (toParam) {
          const toAddress = decodeURIComponent(toParam);
          return mockResponse(messages.filter((m) => m.to_address === toAddress));
        }

        return mockResponse([]);
      }
    });

    function mockResponse(data: unknown, ok = true, status = 200): Response {
      return {
        ok,
        status,
        statusText: ok ? "OK" : "Error",
        json: async () => data,
        text: async () => JSON.stringify(data),
      } as unknown as Response;
    }

    // A sends to B
    await sessionA.send!(sessionB.address, "Hello from A", "Hi B, how are you?");

    // B checks inbox - should have A's message
    const bMessages = await sessionB.list();
    expect(bMessages).toHaveLength(1);
    expect(bMessages[0].subject).toBe("Hello from A");
    expect(bMessages[0].from).toBe(sessionA.address);

    // B reads the message
    const bEmail = await sessionB.read(bMessages[0].id);
    expect(bEmail.textBody).toBe("Hi B, how are you?");

    // B replies to A
    await sessionB.send!(sessionA.address, "Re: Hello from A", "Hi A, doing well!");

    // A checks inbox - should have B's reply
    const aMessages = await sessionA.list();
    expect(aMessages).toHaveLength(1);
    expect(aMessages[0].subject).toBe("Re: Hello from A");
    expect(aMessages[0].from).toBe(sessionB.address);

    // A reads B's reply
    const aEmail = await sessionA.read(aMessages[0].id);
    expect(aEmail.textBody).toBe("Hi A, doing well!");
  });
});
