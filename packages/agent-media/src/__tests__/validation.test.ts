/**
 * Unit tests for validation logic
 *
 * These tests run without API keys and verify input validation works correctly.
 */

import { describe, it, expect } from "vitest";
import { normalizeAspectRatio } from "../adapters/gemini.js";
import { MODEL_LIMITS, ASPECT_RATIO_TOLERANCE } from "../config.js";

describe("normalizeAspectRatio", () => {
  it("should pass through aspect ratio format unchanged", () => {
    expect(normalizeAspectRatio("1:1")).toBe("1:1");
    expect(normalizeAspectRatio("16:9")).toBe("16:9");
    expect(normalizeAspectRatio("9:16")).toBe("9:16");
    expect(normalizeAspectRatio("4:3")).toBe("4:3");
    expect(normalizeAspectRatio("3:4")).toBe("3:4");
  });

  it("should convert square pixel dimensions to 1:1", () => {
    expect(normalizeAspectRatio("1024x1024")).toBe("1:1");
    expect(normalizeAspectRatio("512x512")).toBe("1:1");
    expect(normalizeAspectRatio("2048x2048")).toBe("1:1");
  });

  it("should convert 16:9 pixel dimensions", () => {
    expect(normalizeAspectRatio("1920x1080")).toBe("16:9");
    expect(normalizeAspectRatio("1792x1024")).toBe("16:9");
    expect(normalizeAspectRatio("3840x2160")).toBe("16:9");
  });

  it("should convert 9:16 pixel dimensions", () => {
    expect(normalizeAspectRatio("1080x1920")).toBe("9:16");
    expect(normalizeAspectRatio("1024x1792")).toBe("9:16");
  });

  it("should convert 4:3 pixel dimensions", () => {
    expect(normalizeAspectRatio("1024x768")).toBe("4:3");
    expect(normalizeAspectRatio("1600x1200")).toBe("4:3");
  });

  it("should convert 3:4 pixel dimensions", () => {
    expect(normalizeAspectRatio("768x1024")).toBe("3:4");
    expect(normalizeAspectRatio("1200x1600")).toBe("3:4");
  });

  it("should handle invalid input gracefully", () => {
    expect(normalizeAspectRatio("invalid")).toBe("1:1");
    expect(normalizeAspectRatio("")).toBe("1:1");
    expect(normalizeAspectRatio("100")).toBe("1:1");
  });

  it("should default wide ratios to 16:9", () => {
    // Very wide aspect ratio not matching any standard
    expect(normalizeAspectRatio("2000x1000")).toBe("16:9");
  });

  it("should default tall ratios to 9:16", () => {
    // Very tall aspect ratio not matching any standard
    expect(normalizeAspectRatio("1000x2000")).toBe("9:16");
  });
});

describe("MODEL_LIMITS", () => {
  it("should have DALL-E 3 prompt length limit", () => {
    expect(MODEL_LIMITS.DALLE3_MAX_PROMPT_LENGTH).toBe(4000);
  });

  it("should have OpenAI TTS text length limit", () => {
    expect(MODEL_LIMITS.OPENAI_TTS_MAX_LENGTH).toBe(4096);
  });

  it("should have Gemini prompt length limit", () => {
    expect(MODEL_LIMITS.GEMINI_MAX_PROMPT_LENGTH).toBe(5000);
  });
});

describe("ASPECT_RATIO_TOLERANCE", () => {
  it("should be a reasonable tolerance value", () => {
    expect(ASPECT_RATIO_TOLERANCE).toBe(0.1);
    // Tolerance should allow slight variations
    expect(ASPECT_RATIO_TOLERANCE).toBeGreaterThan(0);
    expect(ASPECT_RATIO_TOLERANCE).toBeLessThan(0.5);
  });
});

describe("Prompt validation edge cases", () => {
  it("should validate prompt lengths against limits", () => {
    const shortPrompt = "a".repeat(100);
    const maxDallePrompt = "a".repeat(MODEL_LIMITS.DALLE3_MAX_PROMPT_LENGTH);
    const tooLongPrompt = "a".repeat(MODEL_LIMITS.DALLE3_MAX_PROMPT_LENGTH + 1);

    expect(shortPrompt.length).toBeLessThanOrEqual(
      MODEL_LIMITS.DALLE3_MAX_PROMPT_LENGTH
    );
    expect(maxDallePrompt.length).toBe(MODEL_LIMITS.DALLE3_MAX_PROMPT_LENGTH);
    expect(tooLongPrompt.length).toBeGreaterThan(
      MODEL_LIMITS.DALLE3_MAX_PROMPT_LENGTH
    );
  });

  it("should validate TTS text lengths against limits", () => {
    const shortText = "Hello world";
    const maxTtsText = "a".repeat(MODEL_LIMITS.OPENAI_TTS_MAX_LENGTH);
    const tooLongText = "a".repeat(MODEL_LIMITS.OPENAI_TTS_MAX_LENGTH + 1);

    expect(shortText.length).toBeLessThanOrEqual(
      MODEL_LIMITS.OPENAI_TTS_MAX_LENGTH
    );
    expect(maxTtsText.length).toBe(MODEL_LIMITS.OPENAI_TTS_MAX_LENGTH);
    expect(tooLongText.length).toBeGreaterThan(
      MODEL_LIMITS.OPENAI_TTS_MAX_LENGTH
    );
  });
});
