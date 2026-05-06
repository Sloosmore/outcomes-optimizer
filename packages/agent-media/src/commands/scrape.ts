/**
 * scrape command — download video or extract transcript from social media URLs
 *
 * Supports YouTube, Instagram, and any platform yt-dlp handles.
 * No API keys required — uses yt-dlp under the hood.
 *
 * Usage:
 *   agent-media scrape <url> [-o path]               # download video
 *   agent-media scrape <url> --transcript             # transcript only
 *   agent-media scrape <url> --transcript -o out.mp4  # video + transcript
 */

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { EXIT_CODES } from "../config.js";

export interface TranscriptSegment {
  start: number; // seconds
  end: number; // seconds
  text: string;
}

export interface ScrapeResult {
  platform: string;
  url: string;
  file?: string;
  transcript?: {
    lang: string;
    segments: TranscriptSegment[];
    fullText: string;
    durationSeconds: number;
  };
}

export interface ScrapeCommandOptions {
  output?: string;
  transcript?: boolean;
  lang?: string;
  json?: boolean;
}

export type Platform = "youtube" | "instagram" | "unknown";

export function detectPlatform(url: string): Platform {
  try {
    const { hostname } = new URL(url);
    if (hostname === "youtu.be" || hostname === "youtube.com" || hostname.endsWith(".youtube.com")) return "youtube";
    if (hostname === "instagram.com" || hostname.endsWith(".instagram.com")) return "instagram";
    return "unknown";
  } catch {
    return "unknown";
  }
}

function checkYtDlp(): void {
  const result = spawnSync("yt-dlp", ["--version"], { encoding: "utf-8" });
  if (result.status !== 0 || result.error) {
    console.error(
      "Error: yt-dlp not found. Install with:\n  brew install yt-dlp\n  # or: pip install yt-dlp"
    );
    process.exit(EXIT_CODES.CONFIG_ERROR);
  }
}

/** Parse VTT timestamp (HH:MM:SS.mmm or MM:SS.mmm) to seconds */
export function vttTimeToSeconds(ts: string): number {
  const parts = ts.split(":");
  if (parts.length === 3) {
    const [h, m, s] = parts;
    return Number(h) * 3600 + Number(m) * 60 + parseFloat(s);
  }
  const [m, s] = parts;
  return Number(m) * 60 + parseFloat(s);
}

/** Parse a WebVTT file into deduplicated transcript segments */
export function parseVtt(content: string): TranscriptSegment[] {
  const segments: TranscriptSegment[] = [];
  const seenTexts = new Set<string>();

  const cuePattern =
    /(\d{2}:\d{2}:\d{2}\.\d{3}|\d{2}:\d{2}\.\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}\.\d{3}|\d{2}:\d{2}\.\d{3})[^\n]*\n([\s\S]*?)(?=\n\n|\n*$)/g;

  let match: RegExpExecArray | null;
  while ((match = cuePattern.exec(content)) !== null) {
    const text = match[3]
      .replace(/<[^>]+>/g, "")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&nbsp;/g, " ")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .join(" ");

    if (!text || seenTexts.has(text)) continue;
    seenTexts.add(text);
    segments.push({ start: vttTimeToSeconds(match[1]), end: vttTimeToSeconds(match[2]), text });
  }

  return segments;
}

export function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

const SCRAPE_TIMEOUT_MS = 300_000; // 5 minutes

function downloadVideo(url: string, outputPath: string, platform: Platform): void {
  // Use an isolated temp dir so we can find whatever file yt-dlp actually creates —
  // the extension may differ from the template when format fallback occurs.
  let tmpDir: string;
  try {
    tmpDir = mkdtempSync(join(tmpdir(), `scrape-dl-${randomUUID()}-`));
  } catch (err) {
    console.error(`Error creating temp directory: ${err instanceof Error ? err.message : err}`);
    process.exit(EXIT_CODES.COMPLETE_FAILURE);
  }

  const tmpBase = join(tmpDir, "video");
  const args = [
    "--format",
    platform === "instagram"
      ? "bestvideo+bestaudio/best"
      : "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
    "--merge-output-format", "mp4",
    "-o", tmpBase,
    url,
  ];

  const result = spawnSync("yt-dlp", args, { encoding: "utf-8", timeout: SCRAPE_TIMEOUT_MS });

  // Find whatever file yt-dlp actually created, ignoring incomplete .part files
  let downloadedFile: string | undefined;
  try {
    downloadedFile = readdirSync(tmpDir)
      .filter((f) => !f.endsWith(".part"))
      .map((f) => join(tmpDir, f))[0];
  } catch { /* ignore */ }

  if (!downloadedFile || !existsSync(downloadedFile)) {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
    const stderr = result.stderr?.trim() ?? "";
    console.error(`Error downloading video: ${stderr || "yt-dlp produced no output file"}`);
    process.exit(EXIT_CODES.COMPLETE_FAILURE);
  }

  // Move to requested output path; fall back to copy+delete on cross-device rename
  try {
    renameSync(downloadedFile, outputPath);
  } catch {
    copyFileSync(downloadedFile, outputPath);
  } finally {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
  }
}

function fetchTranscript(
  url: string,
  lang: string
): { segments: TranscriptSegment[]; fullText: string; durationSeconds: number } | null {
  // Use an isolated temp directory to avoid scanning the entire system tmpdir
  let tmpDir: string;
  try {
    tmpDir = mkdtempSync(join(tmpdir(), `scrape-${randomUUID()}-`));
  } catch {
    return null;
  }

  const tmpBase = join(tmpDir, "subs");

  spawnSync(
    "yt-dlp",
    [
      "--write-auto-subs",
      "--sub-langs", `${lang}.*`,
      "--skip-download",
      "--sub-format", "vtt",
      "-o", tmpBase,
      url,
    ],
    { encoding: "utf-8", timeout: SCRAPE_TIMEOUT_MS }
  );

  // yt-dlp may exit non-zero due to warnings while still writing the VTT — check file first
  let vttFiles: string[];
  try {
    vttFiles = readdirSync(tmpDir)
      .filter((f) => f.endsWith(".vtt"))
      .map((f) => join(tmpDir, f));
  } catch {
    return null;
  }

  const vttFile = vttFiles[0];
  if (!vttFile || !existsSync(vttFile)) {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
    return null;
  }

  let content: string;
  try {
    content = readFileSync(vttFile, "utf-8");
  } catch {
    return null;
  } finally {
    // Clean up all files in the isolated temp dir
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
  }

  const segments = parseVtt(content);
  if (segments.length === 0) return null;

  return {
    segments,
    fullText: segments.map((s) => s.text).join(" "),
    durationSeconds: segments[segments.length - 1]?.end ?? 0,
  };
}

export async function scrapeCommand(url: string, options: ScrapeCommandOptions): Promise<void> {
  // Validate URL before invoking yt-dlp
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      console.error("Error: URL must use http or https protocol");
      process.exit(EXIT_CODES.CONFIG_ERROR);
    }
  } catch {
    console.error("Error: Invalid URL provided");
    process.exit(EXIT_CODES.CONFIG_ERROR);
  }

  checkYtDlp();

  const platform = detectPlatform(url);
  const lang = options.lang ?? "en";
  if (!/^[a-zA-Z]{2,3}([-_][a-zA-Z0-9]+)*$/.test(lang)) {
    console.error(`Error: Invalid language code: ${lang}`);
    process.exit(EXIT_CODES.CONFIG_ERROR);
  }
  const result: ScrapeResult = { platform, url };

  // Video download (default unless --transcript with no -o)
  const wantVideo = !options.transcript || options.output !== undefined;
  if (wantVideo) {
    const outputPath = options.output ?? join(process.cwd(), `scraped-${Date.now()}.mp4`);
    downloadVideo(url, outputPath, platform);
    result.file = outputPath;
  }

  // Transcript (optional bonus, or primary if --transcript without -o)
  if (options.transcript) {
    const data = fetchTranscript(url, lang);
    if (data) {
      result.transcript = { lang, ...data };
    } else if (!options.json) {
      console.error(`Note: No captions available for this ${platform} video.`);
    }
  }

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    if (result.file) {
      console.log(`Downloaded: ${result.file}`);
    }
    if (result.transcript) {
      console.log(`\nTranscript (${result.transcript.segments.length} segments):`);
      for (const seg of result.transcript.segments) {
        console.log(`[${formatTime(seg.start)}] ${seg.text}`);
      }
    }
  }
}
