/**
 * Integration tests for agent-media
 *
 * These tests call real APIs and consume credits. They are SKIPPED by default.
 * Opt in explicitly: RUN_INTEGRATION=true OPENAI_API_KEY=... npm test
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, unlinkSync, mkdirSync, rmdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Explicit opt-in required — API key presence alone is not enough
const RUN_INTEGRATION = !!process.env.RUN_INTEGRATION;

describe.skipIf(!RUN_INTEGRATION)("OpenAI Image Generation", () => {
  let testDir: string;

  beforeAll(() => {
    testDir = join(tmpdir(), `agent-media-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterAll(() => {
    // Cleanup test files
    try {
      const files = readdirSync(testDir);
      for (const file of files) {
        unlinkSync(join(testDir, file));
      }
      rmdirSync(testDir);
    } catch {
      // Ignore cleanup errors
    }
  });

  it("should generate an image with DALL-E 3", async () => {
    const { OpenAIAdapter } = await import("../adapters/openai.js");
    const adapter = new OpenAIAdapter();

    const results = await adapter.generateImage("A simple red circle on white background", {
      size: "1024x1024",
      count: 1,
    });

    expect(results).toHaveLength(1);
    expect(results[0].data).toBeInstanceOf(Buffer);
    expect(results[0].data!.length).toBeGreaterThan(1000);
    expect(results[0].mimeType).toBe("image/png");
    expect(results[0].width).toBe(1024);
    expect(results[0].height).toBe(1024);
  }, 60000); // 60s timeout for API call

  it("should estimate image cost correctly", async () => {
    const { OpenAIAdapter } = await import("../adapters/openai.js");
    const adapter = new OpenAIAdapter();

    const estimate = adapter.estimateCost("image", {
      size: "1024x1024",
      count: 1,
    });

    expect(estimate.min).toBe(0.04);
    expect(estimate.max).toBe(0.04);
    expect(estimate.currency).toBe("USD");
    expect(estimate.breakdown).toContain("$0.04");
  });
});

describe.skipIf(!RUN_INTEGRATION)("OpenAI Audio Generation", () => {
  it("should generate audio with TTS", async () => {
    const { OpenAIAdapter } = await import("../adapters/openai.js");
    const adapter = new OpenAIAdapter();

    const result = await adapter.generateAudio("Hello, this is a test.", {
      voice: "alloy",
      format: "mp3",
    });

    expect(result.data).toBeInstanceOf(Buffer);
    expect(result.data!.length).toBeGreaterThan(1000);
    expect(result.mimeType).toBe("audio/mpeg");
  }, 30000);

  it("should estimate audio cost correctly", async () => {
    const { OpenAIAdapter } = await import("../adapters/openai.js");
    const adapter = new OpenAIAdapter();

    const text = "Hello world"; // 11 characters
    const estimate = adapter.estimateCost("audio", { text });

    expect(estimate.min).toBeCloseTo(0.011 * 0.015, 6); // 11/1000 * $0.015
    expect(estimate.breakdown).toContain("11 characters");
  });
});

describe.skipIf(!RUN_INTEGRATION)("Google Video Generation", () => {
  it("should estimate video cost correctly", async () => {
    const { GoogleAdapter } = await import("../adapters/google.js");
    const adapter = new GoogleAdapter();

    const estimate = adapter.estimateCost("video", { duration: 5 });

    expect(estimate.min).toBe(5 * 0.10); // $0.10/second (Veo 3.1 Fast)
    expect(estimate.breakdown).toContain("5s video");
  });

  // Note: Full video generation test is expensive and slow
  // Uncomment to test manually
  // it("should start video generation", async () => {
  //   const { GoogleAdapter } = await import("../adapters/google.js");
  //   const adapter = new GoogleAdapter();
  //
  //   const job = await adapter.startVideo("A simple animation of a bouncing ball", {
  //     duration: 5,
  //   });
  //
  //   expect(job.id).toBeDefined();
  //   expect(job.status).toBe("pending");
  // }, 120000);
});

describe("Cost Estimation", () => {
  it("should calculate multi-image costs", async () => {
    const { OpenAIAdapter } = await import("../adapters/openai.js");
    const adapter = new OpenAIAdapter();

    const estimate = adapter.estimateCost("image", {
      size: "1024x1024",
      count: 5,
    });

    expect(estimate.min).toBe(0.2); // 5 * $0.04
    expect(estimate.breakdown).toContain("5 images");
  });

  it("should calculate HD image costs", async () => {
    const { OpenAIAdapter } = await import("../adapters/openai.js");
    const adapter = new OpenAIAdapter();

    const estimate = adapter.estimateCost("image", {
      size: "1024x1024",
      quality: "hd",
      count: 1,
    });

    expect(estimate.min).toBe(0.08); // HD pricing
  });
});
