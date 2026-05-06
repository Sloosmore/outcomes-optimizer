/**
 * Unit tests for SRT generation utilities.
 * Runs without network access or ffmpeg — pure function tests only.
 */

import { describe, it, expect } from "vitest";
import { toSRTTime, generateSRT } from "../utils/srt.js";
import type { WordTimestamp } from "../utils/srt.js";

describe("toSRTTime", () => {
  it("formats zero correctly", () => {
    expect(toSRTTime(0)).toBe("00:00:00,000");
  });

  it("formats sub-second timestamps", () => {
    expect(toSRTTime(0.5)).toBe("00:00:00,500");
    expect(toSRTTime(0.001)).toBe("00:00:00,001");
    expect(toSRTTime(0.999)).toBe("00:00:00,999");
  });

  it("formats whole seconds", () => {
    expect(toSRTTime(1)).toBe("00:00:01,000");
    expect(toSRTTime(59)).toBe("00:00:59,000");
  });

  it("formats minutes", () => {
    expect(toSRTTime(60)).toBe("00:01:00,000");
    expect(toSRTTime(90)).toBe("00:01:30,000");
    expect(toSRTTime(3599)).toBe("00:59:59,000");
  });

  it("formats hours", () => {
    expect(toSRTTime(3600)).toBe("01:00:00,000");
    expect(toSRTTime(3661.5)).toBe("01:01:01,500");
  });

  it("rounds milliseconds correctly, carrying over at 1000ms boundary", () => {
    // 1.501 seconds → 501 ms (unambiguous)
    expect(toSRTTime(1.501)).toBe("00:00:01,501");
    // 1.9999 seconds → rounds to 2000 ms → carry over to next second
    expect(toSRTTime(1.9999)).toBe("00:00:02,000");
  });

  it("clamps negative input to zero", () => {
    expect(toSRTTime(-1)).toBe("00:00:00,000");
    expect(toSRTTime(-0.5)).toBe("00:00:00,000");
  });
});

describe("generateSRT — word style", () => {
  const words: WordTimestamp[] = [
    { word: "Hello", start: 0.0, end: 0.4 },
    { word: "world", start: 0.5, end: 0.9 },
    { word: "today", start: 1.0, end: 1.5 },
  ];

  it("returns empty string for empty word list", () => {
    expect(generateSRT([], "word")).toBe("");
  });

  it("produces one SRT entry per word", () => {
    const srt = generateSRT(words, "word");
    const blocks = srt.trim().split(/\n\n+/);
    expect(blocks).toHaveLength(3);
  });

  it("uses sequential index starting at 1", () => {
    const srt = generateSRT(words, "word");
    expect(srt).toMatch(/^1\n/);
    expect(srt).toContain("\n2\n");
    expect(srt).toContain("\n3\n");
  });

  it("formats timestamps with --> arrow", () => {
    const srt = generateSRT(words, "word");
    expect(srt).toContain("00:00:00,000 --> 00:00:00,400");
    expect(srt).toContain("00:00:00,500 --> 00:00:00,900");
  });

  it("preserves word text", () => {
    const srt = generateSRT(words, "word");
    expect(srt).toContain("Hello");
    expect(srt).toContain("world");
    expect(srt).toContain("today");
  });
});

describe("generateSRT — line style", () => {
  const words: WordTimestamp[] = Array.from({ length: 12 }, (_, i) => ({
    word: `word${i + 1}`,
    start: i * 0.5,
    end: i * 0.5 + 0.4,
  }));

  it("groups into chunks of 5", () => {
    const srt = generateSRT(words, "line");
    const blocks = srt.trim().split(/\n\n+/);
    // 12 words → ceil(12/5) = 3 blocks
    expect(blocks).toHaveLength(3);
  });

  it("last chunk contains remaining words", () => {
    const srt = generateSRT(words, "line");
    // Last block should have words 11 and 12
    expect(srt).toContain("word11 word12");
  });

  it("returns empty string for empty word list", () => {
    expect(generateSRT([], "line")).toBe("");
  });

  it("handles exactly one chunk", () => {
    const few = words.slice(0, 3);
    const srt = generateSRT(few, "line");
    const blocks = srt.trim().split(/\n\n+/);
    expect(blocks).toHaveLength(1);
    expect(srt).toContain("word1 word2 word3");
  });
});
