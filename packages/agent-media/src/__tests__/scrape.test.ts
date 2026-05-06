/**
 * Unit tests for scrape command utilities.
 * Runs without network access or yt-dlp — pure function tests only.
 */

import { describe, it, expect } from "vitest";
import {
  detectPlatform,
  vttTimeToSeconds,
  formatTime,
  parseVtt,
} from "../commands/scrape.js";

describe("detectPlatform", () => {
  it("detects youtube.com", () => {
    expect(detectPlatform("https://www.youtube.com/watch?v=abc")).toBe("youtube");
  });

  it("detects youtu.be", () => {
    expect(detectPlatform("https://youtu.be/dQw4w9WgXcQ")).toBe("youtube");
  });

  it("detects music.youtube.com subdomain", () => {
    expect(detectPlatform("https://music.youtube.com/watch?v=abc")).toBe("youtube");
  });

  it("does not match evil-youtube.com", () => {
    expect(detectPlatform("https://evil-youtube.com/watch?v=abc")).toBe("unknown");
  });

  it("detects instagram.com", () => {
    expect(detectPlatform("https://www.instagram.com/p/xxx/")).toBe("instagram");
  });

  it("detects instagram.com without www", () => {
    expect(detectPlatform("https://instagram.com/p/xxx/")).toBe("instagram");
  });

  it("returns unknown for other URLs", () => {
    expect(detectPlatform("https://tiktok.com/video/123")).toBe("unknown");
  });

  it("returns unknown for invalid URL", () => {
    expect(detectPlatform("not-a-url")).toBe("unknown");
  });

  it("returns unknown for empty string", () => {
    expect(detectPlatform("")).toBe("unknown");
  });
});

// ── vttTimeToSeconds ──────────────────────────────────────────────────────────

describe("vttTimeToSeconds", () => {
  it("parses HH:MM:SS.mmm format", () => {
    expect(vttTimeToSeconds("00:00:00.000")).toBe(0);
    expect(vttTimeToSeconds("00:01:00.000")).toBe(60);
    expect(vttTimeToSeconds("01:00:00.000")).toBe(3600);
    expect(vttTimeToSeconds("01:23:45.678")).toBeCloseTo(3600 + 23 * 60 + 45.678);
  });

  it("parses MM:SS.mmm format", () => {
    expect(vttTimeToSeconds("00:00.000")).toBe(0);
    expect(vttTimeToSeconds("01:30.500")).toBeCloseTo(90.5);
    expect(vttTimeToSeconds("10:00.000")).toBe(600);
  });
});

// ── formatTime ────────────────────────────────────────────────────────────────

describe("formatTime", () => {
  it("formats zero", () => {
    expect(formatTime(0)).toBe("0:00");
  });

  it("formats sub-minute", () => {
    expect(formatTime(45)).toBe("0:45");
    expect(formatTime(9)).toBe("0:09");
  });

  it("formats minutes", () => {
    expect(formatTime(60)).toBe("1:00");
    expect(formatTime(90)).toBe("1:30");
    expect(formatTime(3599)).toBe("59:59");
  });

  it("formats hours as large minutes", () => {
    expect(formatTime(3600)).toBe("60:00");
    expect(formatTime(3661)).toBe("61:01");
  });

  it("truncates fractional seconds", () => {
    expect(formatTime(90.9)).toBe("1:30");
  });
});

// ── parseVtt ─────────────────────────────────────────────────────────────────

describe("parseVtt", () => {
  it("returns empty array for empty content", () => {
    expect(parseVtt("")).toHaveLength(0);
  });

  it("returns empty array for content with no cues", () => {
    expect(parseVtt("WEBVTT\n\n")).toHaveLength(0);
  });

  it("parses a basic cue", () => {
    const vtt = `WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nHello world\n\n`;
    const segments = parseVtt(vtt);
    expect(segments).toHaveLength(1);
    expect(segments[0].text).toBe("Hello world");
    expect(segments[0].start).toBe(1);
    expect(segments[0].end).toBe(3);
  });

  it("strips VTT timing tags from text", () => {
    const vtt = `WEBVTT\n\n00:00:01.000 --> 00:00:03.000\n<00:00:01.500><c>tagged</c> text\n\n`;
    const segments = parseVtt(vtt);
    expect(segments[0].text).toBe("tagged text");
  });

  it("decodes HTML entities", () => {
    const vtt = `WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nfoo &amp; bar &lt;baz&gt;\n\n`;
    const segments = parseVtt(vtt);
    expect(segments[0].text).toBe("foo & bar <baz>");
  });

  it("deduplicates repeated cue text", () => {
    const vtt = `WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHello world\n\n00:00:01.500 --> 00:00:02.500\nHello world\n\n`;
    const segments = parseVtt(vtt);
    expect(segments).toHaveLength(1);
  });

  it("parses multiple distinct cues", () => {
    const vtt = [
      "WEBVTT",
      "",
      "00:00:01.000 --> 00:00:02.000",
      "First line",
      "",
      "00:00:03.000 --> 00:00:04.000",
      "Second line",
      "",
    ].join("\n");
    const segments = parseVtt(vtt);
    expect(segments).toHaveLength(2);
    expect(segments[0].text).toBe("First line");
    expect(segments[1].text).toBe("Second line");
  });
});
