import { mkdir, rm, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadState,
  saveState,
  clearState,
  markSeen,
  filterUnseen,
  type InboxState,
} from "../state/inbox.js";

// Helper to create test state with required credentials
function createTestState(overrides: Partial<InboxState> = {}): InboxState {
  return {
    address: "test@1secmail.com",
    login: "test",
    domain: "1secmail.com",
    created: "2024-01-01T00:00:00.000Z",
    adapter: "1secmail",
    seenIds: [],
    credentials: {
      address: "test@1secmail.com",
      login: "test",
      domain: "1secmail.com",
    },
    ...overrides,
  };
}

describe("state management", () => {
  const testDir = join(tmpdir(), `agent-email-test-${Date.now()}`);

  beforeEach(async () => {
    // Set custom state directory for tests
    process.env.AGENT_EMAIL_STATE_DIR = testDir;
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    // Clean up
    delete process.env.AGENT_EMAIL_STATE_DIR;
    if (existsSync(testDir)) {
      await rm(testDir, { recursive: true });
    }
  });

  it("returns null when no state exists", async () => {
    const state = await loadState();
    expect(state).toBeNull();
  });

  it("saves and loads state correctly", async () => {
    const testState = createTestState({ seenIds: ["1", "2", "3"] });

    await saveState(testState);
    const loaded = await loadState();

    expect(loaded).toEqual(testState);
  });

  it("clears state correctly", async () => {
    const testState = createTestState();

    await saveState(testState);
    expect(await loadState()).not.toBeNull();

    await clearState();
    expect(await loadState()).toBeNull();
  });

  it("marks emails as seen", async () => {
    const testState = createTestState({ seenIds: ["1"] });

    await saveState(testState);
    await markSeen(["2", "3"]);

    const loaded = await loadState();
    expect(loaded?.seenIds).toEqual(["1", "2", "3"]);
  });

  it("does not duplicate seen IDs", async () => {
    const testState = createTestState({ seenIds: ["1", "2"] });

    await saveState(testState);
    await markSeen(["2", "3"]); // 2 is already seen

    const loaded = await loadState();
    expect(loaded?.seenIds).toEqual(["1", "2", "3"]);
  });

  describe("filterUnseen", () => {
    it("filters out seen IDs", () => {
      const state = createTestState({ seenIds: ["1", "2", "3"] });

      const unseen = filterUnseen(state, ["1", "2", "3", "4", "5"]);
      expect(unseen).toEqual(["4", "5"]);
    });

    it("returns all IDs when none are seen", () => {
      const state = createTestState({ seenIds: [] });

      const unseen = filterUnseen(state, ["1", "2", "3"]);
      expect(unseen).toEqual(["1", "2", "3"]);
    });

    it("returns empty array when all are seen", () => {
      const state = createTestState({ seenIds: ["1", "2", "3"] });

      const unseen = filterUnseen(state, ["1", "2", "3"]);
      expect(unseen).toEqual([]);
    });
  });
});
