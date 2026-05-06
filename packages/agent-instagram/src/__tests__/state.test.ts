import { mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadSession,
  saveSession,
  clearSession,
  type SessionState,
} from "../state/session.js";

function createTestSession(overrides: Partial<SessionState> = {}): SessionState {
  return {
    accessToken: "test-token-abc123",
    businessAccountId: "123456789",
    username: "testuser",
    created: "2024-01-01T00:00:00.000Z",
    adapter: "instagram-api",
    ...overrides,
  };
}

describe("session state management", () => {
  const testDir = join(tmpdir(), `agent-instagram-test-${Date.now()}`);

  beforeEach(async () => {
    process.env.AGENT_INSTAGRAM_STATE_DIR = testDir;
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    delete process.env.AGENT_INSTAGRAM_STATE_DIR;
    if (existsSync(testDir)) {
      await rm(testDir, { recursive: true });
    }
  });

  it("returns null when no session exists", async () => {
    const session = await loadSession();
    expect(session).toBeNull();
  });

  it("saves and loads session correctly", async () => {
    const testSession = createTestSession();

    await saveSession(testSession);
    const loaded = await loadSession();

    expect(loaded).toEqual(testSession);
  });

  it("clears session correctly", async () => {
    const testSession = createTestSession();

    await saveSession(testSession);
    expect(await loadSession()).not.toBeNull();

    await clearSession();
    expect(await loadSession()).toBeNull();
  });

  it("overwrites existing session on save", async () => {
    const first = createTestSession({ username: "first" });
    const second = createTestSession({ username: "second" });

    await saveSession(first);
    await saveSession(second);

    const loaded = await loadSession();
    expect(loaded?.username).toBe("second");
  });

  it("returns null for corrupted state file", async () => {
    // Save invalid JSON
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(testDir, "session.json"), "not json", "utf-8");

    const session = await loadSession();
    expect(session).toBeNull();
  });

  it("returns null for state missing required fields", async () => {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      join(testDir, "session.json"),
      JSON.stringify({ accessToken: "token" }),
      "utf-8"
    );

    const session = await loadSession();
    expect(session).toBeNull();
  });

  it("preserves all session fields", async () => {
    const testSession = createTestSession({
      accessToken: "long-token-value-xyz",
      businessAccountId: "987654321",
      username: "myaccount",
      adapter: "instagram-api",
    });

    await saveSession(testSession);
    const loaded = await loadSession();

    expect(loaded?.accessToken).toBe("long-token-value-xyz");
    expect(loaded?.businessAccountId).toBe("987654321");
    expect(loaded?.username).toBe("myaccount");
    expect(loaded?.adapter).toBe("instagram-api");
  });
});

describe("state directory configuration", () => {
  it("rejects relative paths in AGENT_INSTAGRAM_STATE_DIR", async () => {
    process.env.AGENT_INSTAGRAM_STATE_DIR = "./relative/path";

    // Import fresh to test the validation
    const { getStateDir } = await import("../state/session.js");

    expect(() => getStateDir()).toThrow("must be an absolute path");

    delete process.env.AGENT_INSTAGRAM_STATE_DIR;
  });
});
