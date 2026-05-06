#!/usr/bin/env npx tsx
/**
 * verify-pipeline.ts — Technology QA check for the caption/assemble pipeline.
 *
 * Answers one question: does our pipeline produce correct output?
 * Not "is it viral-quality" — just "do captions appear, sync with speech,
 * and does assembly produce a playable file?"
 *
 * Usage:
 *   npx tsx packages/agent-media/scripts/verify-pipeline.ts \
 *     --output-dir workspace/verify
 *
 * Exit codes:
 *   0 — all checks passed
 *   1 — one or more checks failed
 */

import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

const execFile = promisify(execFileCb);

// ---------------------------------------------------------------------------
// Test fixtures — short CC0/CC-BY video clips with clear human speech
// ---------------------------------------------------------------------------
// All clips are ≤15s, have visible human speech, and are suitable for Whisper.
// Downloaded via yt-dlp (YouTube) or curl (Wikimedia direct mp4).
const TEST_VIDEOS = [
  {
    id: "test-1",
    // NASA Apollo 17 EVA — clear astronaut speech, CC0/public domain, ~12s
    url: "https://upload.wikimedia.org/wikipedia/commons/transcoded/e/e3/Apollo_17_EVA-1_drive_and_ALSEP_deploy.ogv/Apollo_17_EVA-1_drive_and_ALSEP_deploy.ogv.360p.webm",
    label: "single speaker (astronaut)",
  },
  {
    id: "test-2",
    // US government public domain educational clip — clear speech, ~10s
    url: "https://upload.wikimedia.org/wikipedia/commons/transcoded/6/6c/Envision_Utah_General_Meeting_%28Speech%29.ogv/Envision_Utah_General_Meeting_%28Speech%29.ogv.360p.webm",
    label: "public speech",
  },
  {
    id: "test-3",
    // President Kennedy Moon Speech excerpt — archival but clear, CC0, ~8s
    url: "https://upload.wikimedia.org/wikipedia/commons/transcoded/4/40/John_F._Kennedy_speech_at_Rice_University.ogv/John_F._Kennedy_speech_at_Rice_University.ogv.360p.webm",
    label: "archival speech (JFK)",
  },
] as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(msg: string) {
  process.stdout.write(msg + "\n");
}

async function run(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFile(cmd, args, { maxBuffer: 50 * 1024 * 1024 });
}

async function runAgent(args: string[]): Promise<{ stdout: string; code: number }> {
  try {
    const { stdout } = await execFile("npx", ["agent-media", ...args], {
      maxBuffer: 10 * 1024 * 1024,
    });
    return { stdout, code: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: string; code?: number };
    return { stdout: e.stdout ?? "", code: e.code ?? 1 };
  }
}

async function ensureDir(dir: string) {
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
}

async function downloadWithYtdlp(url: string, outputPath: string): Promise<boolean> {
  try {
    // Try yt-dlp first for YouTube/video URLs
    await run("yt-dlp", [
      "-f",
      "bestvideo[height<=480][ext=mp4]+bestaudio/best[ext=mp4]/best",
      "--merge-output-format",
      "mp4",
      "-o",
      outputPath,
      "--no-playlist",
      url,
    ]);
    return existsSync(outputPath);
  } catch {
    return false;
  }
}

async function downloadWithCurl(url: string, outputPath: string): Promise<boolean> {
  try {
    await run("curl", ["-L", "-s", "-o", outputPath, url]);
    const s = await stat(outputPath);
    return s.size > 1000;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Per-video check
// ---------------------------------------------------------------------------

interface VariantResult {
  variant: string;
  wordCount: number;
  verdict: string;
  overall: number;
  assessment: string;
  passed: boolean;
  error?: string;
}

interface VideoResult {
  id: string;
  label: string;
  captionFile: string;
  variants: VariantResult[];
  passed: boolean;
}

async function checkVideo(
  video: (typeof TEST_VIDEOS)[number],
  outputDir: string
): Promise<VideoResult> {
  const videoPath = join(outputDir, `${video.id}.mp4`);

  // Download
  log(`  Downloading ${video.id}…`);
  let downloaded = await downloadWithYtdlp(video.url, videoPath);
  if (!downloaded) {
    downloaded = await downloadWithCurl(video.url, videoPath);
  }

  if (!downloaded) {
    return {
      id: video.id,
      label: video.label,
      captionFile: "",
      variants: [],
      passed: false,
    };
  }

  // Caption with default settings (word, 40pt, white, bottom)
  const captionedPath = join(outputDir, `${video.id}-captioned.mp4`);
  const captionResult = await runAgent([
    "caption",
    videoPath,
    "-o",
    captionedPath,
    "--style",
    "word",
    "--font-size",
    "40",
    "--position",
    "bottom",
    "--color",
    "white",
    "--keep-intermediates",
    "--json",
  ]);

  let wordCount = 0;
  try {
    const parsed = JSON.parse(captionResult.stdout);
    wordCount = parsed.words ?? 0;
  } catch {
    // non-JSON output — word count stays 0
  }

  // Review captioned output
  const reviewResult = await runAgent([
    "read",
    captionedPath,
    "--review",
    "--json",
    "--focus",
    "captions are visible, correctly positioned, and synchronized with the spoken words; no text overflow or rendering glitches",
  ]);

  let verdict = "regenerate";
  let overall = 0;
  let assessment = "Review failed";

  try {
    const parsed = JSON.parse(reviewResult.stdout);
    verdict = parsed.review?.verdict ?? verdict;
    overall = parsed.review?.overall ?? overall;
    assessment = parsed.review?.assessment ?? assessment;
  } catch {
    // keep defaults
  }

  const passed = wordCount > 0 && verdict !== "regenerate";

  const variant: VariantResult = {
    variant: "word-default",
    wordCount,
    verdict,
    overall,
    assessment,
    passed,
  };

  const icon = passed ? "✓" : "✗";
  log(
    `  ${icon} ${video.id} (${video.label}) — ${wordCount} words, verdict: ${verdict}, overall: ${overall}/10`
  );

  return {
    id: video.id,
    label: video.label,
    captionFile: captionedPath,
    variants: [variant],
    passed,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const outputDirIdx = args.indexOf("--output-dir");
  const outputDir = outputDirIdx >= 0 ? args[outputDirIdx + 1] : "workspace/verify";

  await ensureDir(outputDir);

  log(`\nCaption pipeline verification`);
  log(`Output dir: ${outputDir}\n`);

  const results: VideoResult[] = [];

  for (const video of TEST_VIDEOS) {
    log(`Checking ${video.id} (${video.label})…`);
    const result = await checkVideo(video, outputDir);
    results.push(result);
  }

  const passed = results.filter((r) => r.passed).length;
  const total = results.length;

  log(`\nResult: ${passed}/${total} passed`);

  const report = {
    timestamp: new Date().toISOString(),
    passed: passed === total,
    results: results.map((r) => ({
      id: r.id,
      label: r.label,
      captionFile: r.captionFile,
      whisperWordCount: r.variants[0]?.wordCount ?? 0,
      verdict: r.variants[0]?.verdict ?? "error",
      overall: r.variants[0]?.overall ?? 0,
      assessment: r.variants[0]?.assessment ?? "",
      passed: r.passed,
    })),
  };

  const reportPath = join(outputDir, "report.json");
  await writeFile(reportPath, JSON.stringify(report, null, 2), "utf-8");
  log(`Report: ${reportPath}`);

  process.exit(passed === total ? 0 : 1);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
