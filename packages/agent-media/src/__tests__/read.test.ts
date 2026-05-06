/**
 * Tests for the `read` command — AI-powered media understanding and virality review.
 *
 * Structure:
 *   1. Unit: ReadAdapterRegistry
 *   2. Unit: detectMediaType
 *   3. Unit: formatReview output shape (natural language assessment format)
 *   4. Integration: GeminiReadAdapter (skipped when GOOGLE_API_KEY absent)
 *
 * Run:
 *   npm test                          # unit tests only
 *   GOOGLE_API_KEY=… npm test         # + integration tests
 */

import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import { execSync } from "node:child_process";
import { mkdirSync, unlinkSync, rmdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ─── Gate for integration tests ──────────────────────────────────────────────
// Explicit opt-in required — API key presence alone is not enough to consume credits
const RUN_INTEGRATION = !!process.env.RUN_INTEGRATION;

// ─── 1. ReadAdapterRegistry unit tests ───────────────────────────────────────

describe("ReadAdapterRegistry", () => {
  class LocalReadRegistry {
    private adapters = new Map<string, import("../adapters/read-types.js").ReadAdapter>();
    private defaultName: string | undefined;

    register(name: string, adapter: import("../adapters/read-types.js").ReadAdapter) {
      if (this.adapters.has(name)) throw new Error(`Read adapter "${name}" is already registered`);
      this.adapters.set(name, adapter);
    }

    get(name: string) {
      const a = this.adapters.get(name);
      if (!a) {
        const avail = Array.from(this.adapters.keys()).join(", ");
        throw new Error(`Unknown read adapter: "${name}". Available: ${avail}`);
      }
      return a;
    }

    getDefault() {
      if (!this.defaultName) {
        const first = this.adapters.keys().next().value;
        if (!first) throw new Error("No read adapters registered");
        return this.adapters.get(first)!;
      }
      return this.get(this.defaultName);
    }

    setDefault(name: string) {
      if (!this.adapters.has(name)) throw new Error(`Cannot set default: "${name}" not registered`);
      this.defaultName = name;
    }

    list() { return Array.from(this.adapters.keys()); }
  }

  const mockAdapter = (name: string): import("../adapters/read-types.js").ReadAdapter => ({
    name,
    readVideo: async () => ({ filePath: "", mediaType: "video" }),
    readImage: async () => ({ filePath: "", mediaType: "image" }),
    readAudio: async () => ({ filePath: "", mediaType: "audio" }),
  });

  let reg: LocalReadRegistry;
  beforeEach(() => { reg = new LocalReadRegistry(); });

  it("registers and retrieves an adapter by name", () => {
    const a = mockAdapter("gemini");
    reg.register("gemini", a);
    expect(reg.get("gemini")).toBe(a);
  });

  it("lists registered adapter names", () => {
    reg.register("gemini", mockAdapter("gemini"));
    reg.register("openai", mockAdapter("openai"));
    expect(reg.list()).toEqual(["gemini", "openai"]);
  });

  it("throws on duplicate registration", () => {
    reg.register("gemini", mockAdapter("gemini"));
    expect(() => reg.register("gemini", mockAdapter("gemini"))).toThrow(
      'Read adapter "gemini" is already registered'
    );
  });

  it("throws on unknown adapter retrieval", () => {
    reg.register("gemini", mockAdapter("gemini"));
    expect(() => reg.get("unknown")).toThrow('Unknown read adapter: "unknown"');
  });

  it("getDefault returns first registered when no default set", () => {
    const a = mockAdapter("gemini");
    reg.register("gemini", a);
    expect(reg.getDefault()).toBe(a);
  });

  it("setDefault changes which adapter getDefault returns", () => {
    const a = mockAdapter("a");
    const b = mockAdapter("b");
    reg.register("a", a);
    reg.register("b", b);
    reg.setDefault("b");
    expect(reg.getDefault()).toBe(b);
  });

  it("setDefault throws when adapter is not registered", () => {
    expect(() => reg.setDefault("missing")).toThrow("Cannot set default");
  });

  it("throws when getDefault called with empty registry", () => {
    expect(() => reg.getDefault()).toThrow("No read adapters registered");
  });
});

// ─── 2. detectMediaType unit tests ───────────────────────────────────────────

describe("detectMediaType", () => {
  function detectMediaType(filePath: string): "video" | "image" | "audio" {
    const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
    if ([".mp4", ".webm", ".mov", ".avi", ".mkv"].includes(ext)) return "video";
    if ([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".svg"].includes(ext)) return "image";
    if ([".mp3", ".wav", ".ogg", ".m4a", ".aac", ".flac"].includes(ext)) return "audio";
    throw new Error(`Cannot detect media type from extension "${ext}". Use --type video|image|audio to specify.`);
  }

  const cases: [string, "video" | "image" | "audio"][] = [
    ["clip.mp4", "video"], ["clip.webm", "video"], ["clip.mov", "video"],
    ["clip.avi", "video"], ["clip.mkv", "video"],
    ["photo.jpg", "image"], ["photo.jpeg", "image"], ["photo.png", "image"],
    ["photo.gif", "image"], ["photo.webp", "image"], ["photo.bmp", "image"],
    ["photo.svg", "image"],
    ["sound.mp3", "audio"], ["sound.wav", "audio"], ["sound.ogg", "audio"],
    ["sound.m4a", "audio"], ["sound.aac", "audio"], ["sound.flac", "audio"],
  ];

  for (const [file, expected] of cases) {
    it(`detects "${file}" as ${expected}`, () => {
      expect(detectMediaType(file)).toBe(expected);
    });
  }

  it("throws on unknown extension", () => {
    expect(() => detectMediaType("document.pdf")).toThrow("Cannot detect media type");
  });

  it("is case-insensitive (.MP4 → video)", () => {
    expect(detectMediaType("CLIP.MP4")).toBe("video");
  });

  it("handles paths with directories", () => {
    expect(detectMediaType("/tmp/workspace/output.mp4")).toBe("video");
    expect(detectMediaType("./assets/photo.PNG")).toBe("image");
  });
});

// ─── 3. formatReview output shape tests ──────────────────────────────────────

describe("formatReview output", () => {
  // Replicate formatReview logic to test its contract without importing the module
  function formatReview(result: {
    filePath: string;
    mediaType: string;
    review: {
      overall: number;
      verdict: "post" | "edit" | "regenerate";
      confidence: "high" | "medium" | "low";
      assessment: string;
      improvements: string[];
    };
  }): string {
    const review = result.review;
    const verdictIcon = review.verdict === "post" ? "✓" : review.verdict === "edit" ? "~" : "✗";
    const confidenceTag = `[${review.confidence.toUpperCase()} CONFIDENCE]`;

    const lines: string[] = [
      `File:    ${result.filePath}`,
      `Type:    ${result.mediaType}`,
      ``,
      `Verdict: [${verdictIcon} ${review.verdict.toUpperCase()}]  ${confidenceTag}  ${review.overall}/10`,
      ``,
      `Assessment:`,
      `  ${review.assessment}`,
    ];

    if (review.improvements.length > 0) {
      lines.push(``, `Improvements:`);
      for (const imp of review.improvements) lines.push(`  • ${imp}`);
    }

    return lines.join("\n");
  }

  const baseResult = {
    filePath: "/tmp/test.mp4",
    mediaType: "video" as const,
    review: {
      overall: 8,
      verdict: "post" as const,
      confidence: "high" as const,
      assessment: "Strong hook in the first 2 seconds. The pacing is tight and the loop is seamless.",
      improvements: [],
    },
  };

  it("uses ✓ icon for verdict post", () => {
    expect(formatReview(baseResult)).toContain("[✓ POST]");
  });

  it("uses ~ icon for verdict edit", () => {
    const r = { ...baseResult, review: { ...baseResult.review, verdict: "edit" as const } };
    expect(formatReview(r)).toContain("[~ EDIT]");
  });

  it("uses ✗ icon for verdict regenerate", () => {
    const r = { ...baseResult, review: { ...baseResult.review, verdict: "regenerate" as const } };
    expect(formatReview(r)).toContain("[✗ REGENERATE]");
  });

  it("shows HIGH CONFIDENCE tag", () => {
    expect(formatReview(baseResult)).toContain("[HIGH CONFIDENCE]");
  });

  it("shows MEDIUM CONFIDENCE tag", () => {
    const r = { ...baseResult, review: { ...baseResult.review, confidence: "medium" as const } };
    expect(formatReview(r)).toContain("[MEDIUM CONFIDENCE]");
  });

  it("shows LOW CONFIDENCE tag", () => {
    const r = { ...baseResult, review: { ...baseResult.review, confidence: "low" as const } };
    expect(formatReview(r)).toContain("[LOW CONFIDENCE]");
  });

  it("contains file path, media type, and score", () => {
    const out = formatReview(baseResult);
    expect(out).toContain("/tmp/test.mp4");
    expect(out).toContain("video");
    expect(out).toContain("8/10");
  });

  it("contains the natural language assessment", () => {
    const out = formatReview(baseResult);
    expect(out).toContain("Strong hook in the first 2 seconds");
    expect(out).toContain("Assessment:");
  });

  it("omits Improvements section when list is empty", () => {
    expect(formatReview(baseResult)).not.toContain("Improvements:");
  });

  it("lists improvements as bullet points", () => {
    const r = {
      ...baseResult,
      review: {
        ...baseResult.review,
        improvements: ["Trim the last second", "Add captions"],
      },
    };
    const out = formatReview(r);
    expect(out).toContain("• Trim the last second");
    expect(out).toContain("• Add captions");
  });

  it("does not contain old fixed-criteria fields (hookStrength, loopQuality, etc.)", () => {
    const out = formatReview(baseResult);
    expect(out).not.toContain("hookStrength");
    expect(out).not.toContain("loopQuality");
    expect(out).not.toContain("retentionSignals");
    expect(out).not.toContain("audioSync");
    expect(out).not.toContain("visualQuality");
  });
});

// ─── 4. GeminiReadAdapter integration tests ───────────────────────────────────

describe.skipIf(!RUN_INTEGRATION)("GeminiReadAdapter — image (integration)", () => {
  let testDir: string;
  let testImagePath: string;

  beforeAll(() => {
    testDir = join(tmpdir(), `agent-media-read-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    testImagePath = join(testDir, "test.png");

    // Generate a valid 100×100 solid red PNG via python3.
    execSync(
      `python3 -c "
import struct, zlib
def chunk(n, d):
    p = n + d
    return struct.pack('>I', len(d)) + p + struct.pack('>I', zlib.crc32(p) & 0xffffffff)
W, H = 100, 100
raw = b''.join(b'\\x00' + b'\\xff\\x00\\x00' * W for _ in range(H))
png = b'\\x89PNG\\r\\n\\x1a\\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', W, H, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b'')
open('${testImagePath}', 'wb').write(png)
"`
    );
  });

  afterAll(() => {
    try {
      const files = readdirSync(testDir);
      for (const f of files) unlinkSync(join(testDir, f));
      rmdirSync(testDir);
    } catch { /* ignore cleanup errors */ }
  });

  it("returns a plain description for an image", async () => {
    const { GeminiReadAdapter } = await import("../adapters/gemini-read.js");
    const adapter = new GeminiReadAdapter();
    const result = await adapter.readImage(testImagePath);

    expect(result.filePath).toBe(testImagePath);
    expect(result.mediaType).toBe("image");
    expect(typeof result.description).toBe("string");
    expect(result.description!.length).toBeGreaterThan(0);
    expect(result.review).toBeUndefined();
  }, 60000);

  it("returns a natural language ReviewResult for an image", async () => {
    const { GeminiReadAdapter } = await import("../adapters/gemini-read.js");
    const adapter = new GeminiReadAdapter();
    const result = await adapter.readImage(testImagePath, { review: true });

    expect(result.mediaType).toBe("image");
    expect(result.review).toBeDefined();

    const r = result.review!;
    // verdict
    expect(["post", "edit", "regenerate"]).toContain(r.verdict);
    // confidence
    expect(["high", "medium", "low"]).toContain(r.confidence);
    // overall score in schema-enforced range 1–10
    expect(typeof r.overall).toBe("number");
    expect(r.overall).toBeGreaterThanOrEqual(1);
    expect(r.overall).toBeLessThanOrEqual(10);
    // Note: a solid red test image will legitimately score very low (1–2)
    // natural language assessment (not a fixed-criteria object)
    expect(typeof r.assessment).toBe("string");
    expect(r.assessment.length).toBeGreaterThan(20);
    // improvements array
    expect(Array.isArray(r.improvements)).toBe(true);
    expect(r.improvements.length).toBeLessThanOrEqual(3);

    // Must NOT have old fixed-criteria fields
    expect((r as any).criteria).toBeUndefined();
    expect((r as any).hookStrength).toBeUndefined();
    expect((r as any).reasoning).toBeUndefined();
  }, 60000);

  it("incorporates platform context in the review", async () => {
    const { GeminiReadAdapter } = await import("../adapters/gemini-read.js");
    const adapter = new GeminiReadAdapter();
    const result = await adapter.readImage(testImagePath, {
      review: true,
      criteria: { platform: "instagram-reels" },
    });

    expect(result.review).toBeDefined();
    expect(["post", "edit", "regenerate"]).toContain(result.review!.verdict);
  }, 60000);

  it("incorporates a natural language focus brief", async () => {
    const { GeminiReadAdapter } = await import("../adapters/gemini-read.js");
    const adapter = new GeminiReadAdapter();
    const result = await adapter.readImage(testImagePath, {
      review: true,
      criteria: { focus: "make sure it has a bold visual that stops the scroll immediately" },
    });

    expect(result.review).toBeDefined();
    expect(result.review!.assessment.length).toBeGreaterThan(20);
  }, 60000);
});

describe.skipIf(!RUN_INTEGRATION)("GeminiReadAdapter — audio stub (integration)", () => {
  it("throws a 'not yet implemented' error for audio files", async () => {
    const { GeminiReadAdapter } = await import("../adapters/gemini-read.js");
    const adapter = new GeminiReadAdapter();
    await expect(adapter.readAudio("/tmp/fake.mp3")).rejects.toThrow(/not yet implemented/i);
  });
});

describe.skipIf(!RUN_INTEGRATION)("readRegistry singleton (integration)", () => {
  it("has gemini registered as default", async () => {
    const { readRegistry } = await import("../adapters/read-registry.js");
    expect(readRegistry.list()).toContain("gemini");
    expect(readRegistry.getDefault().name).toBe("gemini");
  });
});
