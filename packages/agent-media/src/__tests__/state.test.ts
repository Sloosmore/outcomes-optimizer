import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmdirSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("Jobs State Management", () => {
  let testDir: string;
  let originalEnv: string | undefined;

  beforeEach(() => {
    testDir = join(tmpdir(), `agent-media-state-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    originalEnv = process.env.AGENT_MEDIA_STATE_DIR;
    process.env.AGENT_MEDIA_STATE_DIR = testDir;
  });

  afterEach(() => {
    // Restore env
    if (originalEnv) {
      process.env.AGENT_MEDIA_STATE_DIR = originalEnv;
    } else {
      delete process.env.AGENT_MEDIA_STATE_DIR;
    }

    // Cleanup
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  it("should add and retrieve jobs", async () => {
    const { addJob, getJob, listJobs } = await import("../state/jobs.js");

    const job = {
      id: "test-123",
      status: "pending" as const,
      prompt: "test prompt",
      adapter: "google",
      createdAt: new Date().toISOString(),
    };

    await addJob(job);

    const retrieved = await getJob("test-123");
    expect(retrieved).toEqual(job);

    const all = await listJobs();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe("test-123");
  });

  it("should update job status", async () => {
    const { addJob, updateJob, getJob } = await import("../state/jobs.js");

    await addJob({
      id: "test-456",
      status: "pending",
      prompt: "test",
      adapter: "google",
      createdAt: new Date().toISOString(),
    });

    await updateJob("test-456", {
      status: "completed",
      completedAt: new Date().toISOString(),
      result: { url: "https://example.com/video.mp4" },
    });

    const job = await getJob("test-456");
    expect(job?.status).toBe("completed");
    expect(job?.result?.url).toBe("https://example.com/video.mp4");
  });

  it("should remove jobs", async () => {
    const { addJob, removeJob, getJob } = await import("../state/jobs.js");

    await addJob({
      id: "test-789",
      status: "pending",
      prompt: "test",
      adapter: "google",
      createdAt: new Date().toISOString(),
    });

    await removeJob("test-789");

    const job = await getJob("test-789");
    expect(job).toBeUndefined();
  });

  it("should list jobs by status", async () => {
    const { addJob, listJobsByStatus } = await import("../state/jobs.js");

    await addJob({
      id: "pending-1",
      status: "pending",
      prompt: "test",
      adapter: "google",
      createdAt: new Date().toISOString(),
    });

    await addJob({
      id: "completed-1",
      status: "completed",
      prompt: "test",
      adapter: "google",
      createdAt: new Date().toISOString(),
    });

    const pending = await listJobsByStatus("pending");
    expect(pending).toHaveLength(1);
    expect(pending[0].id).toBe("pending-1");

    const completed = await listJobsByStatus("completed");
    expect(completed).toHaveLength(1);
    expect(completed[0].id).toBe("completed-1");
  });
});
