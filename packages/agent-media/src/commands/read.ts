/**
 * Read command — AI-powered media understanding and virality review
 *
 * Usage:
 *   agent-media read <file> [--review] [--adapter gemini] [--type video|image|audio]
 *                           [--platform youtube-shorts|instagram-reels|general]
 *                           [--focus "natural language brief"]
 *                           [--json] [--output <path>]
 *
 * Exit codes (--review mode):
 *   0  post       — ready to publish
 *   1  edit       — fixable, minor changes needed
 *   2  regenerate — start over
 *   3  error
 *
 * Exit codes (description mode):
 *   0  success
 *   3  error
 */

import { writeFile } from "fs/promises";
import path from "path";
import { readRegistry } from "../adapters/read-registry.js";
import { REVIEW_EXIT_CODES } from "../config.js";
import type { MediaType, ReviewCriteria, ReadResult } from "../adapters/read-types.js";

export interface ReadCommandOptions {
  adapter?: string;
  type?: string;
  review?: boolean;
  platform?: "youtube-shorts" | "instagram-reels" | "general";
  /** Natural language brief — what is this content trying to achieve? */
  focus?: string;
  json?: boolean;
  output?: string;
}

function detectMediaType(filePath: string): MediaType {
  const ext = path.extname(filePath).toLowerCase();
  if ([".mp4", ".webm", ".mov", ".avi", ".mkv"].includes(ext)) return "video";
  if ([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".svg"].includes(ext)) return "image";
  if ([".mp3", ".wav", ".ogg", ".m4a", ".aac", ".flac"].includes(ext)) return "audio";
  throw new Error(
    `Cannot detect media type from extension "${ext}". Use --type video|image|audio to specify.`
  );
}

function formatReview(result: ReadResult): string {
  const review = result.review!;
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
    for (const improvement of review.improvements) {
      lines.push(`  • ${improvement}`);
    }
  }

  return lines.join("\n");
}

export async function readCommand(
  file: string,
  options: ReadCommandOptions
): Promise<void> {
  // Detect or validate media type
  let mediaType: MediaType;
  if (options.type) {
    const t = options.type.toLowerCase();
    if (t !== "video" && t !== "image" && t !== "audio") {
      console.error(`Error: --type must be one of: video, image, audio`);
      process.exit(REVIEW_EXIT_CODES.ERROR);
    }
    mediaType = t as MediaType;
  } else {
    try {
      mediaType = detectMediaType(file);
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : err}`);
      process.exit(REVIEW_EXIT_CODES.ERROR);
    }
  }

  // Get adapter
  const adapterName = options.adapter || "gemini";
  let adapter: import("../adapters/read-types.js").ReadAdapter;
  try {
    adapter = readRegistry.get(adapterName);
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : err}`);
    process.exit(REVIEW_EXIT_CODES.ERROR);
  }

  // Build review criteria
  const criteria: ReviewCriteria = {};
  if (options.platform) criteria.platform = options.platform;
  if (options.focus) criteria.focus = options.focus;

  const readOptions = {
    review: options.review ?? false,
    criteria: Object.keys(criteria).length > 0 ? criteria : undefined,
  };

  // Execute
  let result: ReadResult;
  try {
    if (mediaType === "video") {
      result = await adapter.readVideo(file, readOptions);
    } else if (mediaType === "image") {
      result = await adapter.readImage(file, readOptions);
    } else {
      result = await adapter.readAudio(file, readOptions);
    }
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : err}`);
    process.exit(REVIEW_EXIT_CODES.ERROR);
  }

  // Optionally save to file
  if (options.output) {
    const content = options.json
      ? JSON.stringify(result, null, 2)
      : options.review
        ? formatReview(result)
        : (result.description ?? "");
    await writeFile(options.output, content, "utf-8");
  }

  // Output
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    if (options.review && result.review) {
      console.log(formatReview(result));
    } else {
      console.log(result.description ?? "");
    }
  }

  // Review exit codes: agent can branch on verdict without parsing JSON
  if (options.review && result.review) {
    const { verdict } = result.review;
    if (verdict === "edit") process.exit(REVIEW_EXIT_CODES.EDIT);
    if (verdict === "regenerate") process.exit(REVIEW_EXIT_CODES.REGENERATE);
    // verdict === "post" → falls through to implicit exit 0
  }
}
