/**
 * transcript command - extract transcript from a YouTube video via yt-dlp
 * No YouTube API quota consumed. No OAuth required.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EXIT_CODES } from "../config.js";

export interface TranscriptSegment {
  start: number; // seconds
  end: number; // seconds
  text: string;
}

export interface TranscriptResult {
  videoId: string;
  url: string;
  lang: string;
  segments: TranscriptSegment[];
  fullText: string;
  durationSeconds: number;
}

interface TranscriptOptions {
  lang?: string;
  json?: boolean;
}

/** Extract video ID from any YouTube URL format */
function extractVideoId(url: string): string | null {
  try {
    const parsed = new URL(url);
    // youtu.be/<id>
    if (parsed.hostname === "youtu.be") {
      return parsed.pathname.slice(1).split("/")[0] || null;
    }
    // youtube.com/shorts/<id>
    if (parsed.pathname.startsWith("/shorts/")) {
      return parsed.pathname.split("/shorts/")[1]?.split("/")[0] || null;
    }
    // youtube.com/watch?v=<id>
    return parsed.searchParams.get("v");
  } catch {
    return null;
  }
}

/** Parse VTT timestamp (HH:MM:SS.mmm) to seconds */
function vttTimeToSeconds(ts: string): number {
  const parts = ts.split(":");
  if (parts.length === 3) {
    const [h, m, s] = parts;
    return Number(h) * 3600 + Number(m) * 60 + parseFloat(s);
  }
  // MM:SS.mmm
  const [m, s] = parts;
  return Number(m) * 60 + parseFloat(s);
}

/** Parse a VTT file into deduplicated transcript segments */
function parseVtt(content: string): TranscriptSegment[] {
  const segments: TranscriptSegment[] = [];
  const seenTexts = new Set<string>();

  const cuePattern =
    /(\d{2}:\d{2}:\d{2}\.\d{3}|\d{2}:\d{2}\.\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}\.\d{3}|\d{2}:\d{2}\.\d{3})[^\n]*\n([\s\S]*?)(?=\n\n|\n*$)/g;

  let match: RegExpExecArray | null;
  while ((match = cuePattern.exec(content)) !== null) {
    const startTs = match[1];
    const endTs = match[2];
    const rawText = match[3];

    // Strip VTT tags (<c>, </c>, <00:00:00.000>, etc.) and trim
    const text = rawText
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

    segments.push({
      start: vttTimeToSeconds(startTs),
      end: vttTimeToSeconds(endTs),
      text,
    });
  }

  return segments;
}

/** Format seconds as M:SS */
function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export async function transcriptCommand(
  url: string,
  options: TranscriptOptions
): Promise<void> {
  const lang = options.lang ?? "en";

  const videoId = extractVideoId(url);
  if (!videoId) {
    console.error(`Error: Could not extract video ID from URL: ${url}`);
    process.exit(EXIT_CODES.INVALID_INPUT);
  }

  // Check yt-dlp is available
  const which = spawnSync("which", ["yt-dlp"], { encoding: "utf-8" });
  if (which.status !== 0) {
    console.error(
      "Error: yt-dlp not found. Install it with:\n  brew install yt-dlp\n  # or: pip install yt-dlp"
    );
    process.exit(EXIT_CODES.CONFIG_ERROR);
  }

  const outputTemplate = join(tmpdir(), `transcript-${videoId}`);
  const args = [
    "--write-auto-subs",
    "--sub-langs",
    `${lang}.*`,
    "--skip-download",
    "--sub-format",
    "vtt",
    "-o",
    outputTemplate,
    url,
  ];

  const result = spawnSync("yt-dlp", args, { encoding: "utf-8" });

  // Find the generated VTT file before checking exit status — yt-dlp may exit non-zero
  // due to warnings (impersonation, rate limits on alternate caption tracks) while still
  // having successfully written the primary caption file.
  const dir = tmpdir();
  const prefix = `transcript-${videoId}.`;
  let vttFile: string | undefined;
  try {
    const files = readdirSync(dir);
    vttFile = files
      .filter((f) => f.startsWith(prefix) && f.endsWith(".vtt"))
      .map((f) => join(dir, f))[0];
  } catch {
    // ignore readdir errors
  }

  if (!vttFile || !existsSync(vttFile)) {
    // No VTT produced — surface the yt-dlp error
    if (result.status !== 0) {
      const stderr = result.stderr ?? "";
      if (
        stderr.includes("Private video") ||
        stderr.includes("This video is unavailable") ||
        stderr.includes("age-restricted")
      ) {
        console.error(`Error: ${stderr.trim()}`);
        process.exit(EXIT_CODES.API_ERROR);
      }
      if (stderr.includes("no subtitles") || stderr.includes("No automatic captions")) {
        console.error("No captions available for this video.");
        process.exit(EXIT_CODES.PARTIAL_SUCCESS);
      }
      console.error(`Error running yt-dlp: ${stderr.trim()}`);
      process.exit(EXIT_CODES.API_ERROR);
    }
    console.error("No captions available for this video.");
    process.exit(EXIT_CODES.PARTIAL_SUCCESS);
  }

  let vttContent: string;
  try {
    vttContent = readFileSync(vttFile, "utf-8");
  } catch (err) {
    console.error(`Error reading transcript file: ${err instanceof Error ? err.message : err}`);
    process.exit(EXIT_CODES.API_ERROR);
  } finally {
    // Cleanup temp file regardless of outcome
    try {
      unlinkSync(vttFile);
    } catch {
      // best-effort cleanup
    }
  }

  const segments = parseVtt(vttContent);

  if (segments.length === 0) {
    console.error("No captions available for this video.");
    process.exit(EXIT_CODES.PARTIAL_SUCCESS);
  }

  const durationSeconds = segments[segments.length - 1]?.end ?? 0;
  const fullText = segments.map((s) => s.text).join(" ");

  const output: TranscriptResult = {
    videoId,
    url: `https://www.youtube.com/watch?v=${videoId}`,
    lang,
    segments,
    fullText,
    durationSeconds,
  };

  if (options.json) {
    console.log(JSON.stringify(output, null, 2));
  } else {
    for (const seg of segments) {
      console.log(`[${formatTime(seg.start)}] ${seg.text}`);
    }
  }
}
