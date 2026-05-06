import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Tests for the send command
 */

describe("sendCommand", () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let processExitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    processExitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("prints confirmation after successful send", async () => {
    // Mock state
    const mockState = {
      address: "abc123@throwmail.supa",
      login: "abc123",
      domain: "throwmail.supa",
      created: new Date().toISOString(),
      seenIds: [],
      adapter: "supabase",
      credentials: {
        address: "abc123@throwmail.supa",
        login: "abc123",
        domain: "throwmail.supa",
      },
    };

    const mockSend = vi.fn().mockResolvedValue(undefined);
    const mockSession = {
      address: "abc123@throwmail.supa",
      login: "abc123",
      domain: "throwmail.supa",
      credentials: mockState.credentials,
      list: vi.fn(),
      read: vi.fn(),
      send: mockSend,
    };

    vi.doMock("../state/inbox.js", () => ({
      loadState: vi.fn().mockResolvedValue(mockState),
    }));

    vi.doMock("../adapters/index.js", () => ({
      adapterRegistry: {
        getDefault: vi.fn().mockReturnValue("supabase"),
        get: vi.fn().mockReturnValue({
          restoreSession: vi.fn().mockReturnValue(mockSession),
        }),
      },
    }));

    const { sendCommand } = await import("../commands/send.js");

    await sendCommand("recipient@throwmail.supa", "Test Subject", "Test body", {});

    expect(mockSend).toHaveBeenCalledWith(
      "recipient@throwmail.supa",
      "Test Subject",
      "Test body"
    );
    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining("recipient@throwmail.supa")
    );
    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining("Test Subject")
    );
  });

  it("errors when adapter does not support sending", async () => {
    const mockState = {
      address: "abc123@mailtm.com",
      login: "abc123",
      domain: "mailtm.com",
      created: new Date().toISOString(),
      seenIds: [],
      adapter: "mailtm",
      credentials: {
        address: "abc123@mailtm.com",
        login: "abc123",
        domain: "mailtm.com",
        token: "some-token",
      },
    };

    // Session without send method (mailtm-style)
    const mockSession = {
      address: "abc123@mailtm.com",
      login: "abc123",
      domain: "mailtm.com",
      credentials: mockState.credentials,
      list: vi.fn(),
      read: vi.fn(),
      // No send method
    };

    vi.doMock("../state/inbox.js", () => ({
      loadState: vi.fn().mockResolvedValue(mockState),
    }));

    vi.doMock("../adapters/index.js", () => ({
      adapterRegistry: {
        getDefault: vi.fn().mockReturnValue("mailtm"),
        get: vi.fn().mockReturnValue({
          restoreSession: vi.fn().mockReturnValue(mockSession),
        }),
      },
    }));

    const { sendCommand } = await import("../commands/send.js");

    await expect(
      sendCommand("to@somewhere.com", "Sub", "Bod", {})
    ).rejects.toThrow("process.exit called");

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("does not support sending")
    );
  });

  it("errors when no inbox is initialized", async () => {
    vi.doMock("../state/inbox.js", () => ({
      loadState: vi.fn().mockResolvedValue(null),
    }));

    vi.doMock("../adapters/index.js", () => ({
      adapterRegistry: {
        getDefault: vi.fn().mockReturnValue("supabase"),
        get: vi.fn(),
      },
    }));

    const { sendCommand } = await import("../commands/send.js");

    await expect(
      sendCommand("to@throwmail.supa", "Sub", "Bod", {})
    ).rejects.toThrow("process.exit called");

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("No inbox initialized")
    );
  });
});
