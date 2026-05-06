#!/usr/bin/env node

import "dotenv/config";
import { Command } from "commander";
import {
  imageCommand,
  audioCommand,
  videoCommand,
  listCommand,
  capabilitiesCommand,
  bulkImageCommand,
  readCommand,
  mergeAudioCommand,
  assembleCommand,
  captionCommand,
  trimCommand,
  frameCommand,
  scrapeCommand,
} from "./commands/index.js";
import { EXIT_CODES } from "./config.js";

// Import adapters to register them
import "./adapters/index.js";

/**
 * Wrap async command handlers with proper error handling
 */
function wrapCommand<T extends unknown[]>(
  fn: (...args: T) => Promise<void>
): (...args: T) => void {
  return (...args: T) => {
    fn(...args).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Error: ${message}`);
      process.exit(EXIT_CODES.COMPLETE_FAILURE);
    });
  };
}

const program = new Command();

program
  .name("agent-media")
  .description(
    "CLI for generating media (images, video, audio) in agent workflows"
  )
  .version("0.1.0");

// === Image Generation ===

program
  .command("image <prompt>")
  .description("Generate an image from a text prompt")
  .option("-a, --adapter <name>", "Media adapter (default: gemini)")
  .option("-s, --size <size>", "Image size (default: 1024x1024)")
  .option("-n, --count <n>", "Number of images", (v) => {
    const n = parseInt(v, 10);
    if (isNaN(n) || n < 1) throw new Error("Count must be a positive number");
    return n;
  })
  .option("-q, --quality <quality>", "Quality: standard or hd")
  .option("--style <style>", "Style: natural or vivid")
  .option("-o, --output <path>", "Output file or directory")
  .option("--dry-run", "Show cost estimate without generating")
  .option("--max-cost <usd>", "Maximum cost in USD", parseFloat)
  .option("--force", "Overwrite existing files")
  .option("--json", "Output as JSON")
  .action(wrapCommand((prompt, options) => imageCommand(prompt, options)));

// === Bulk Image Generation ===

program
  .command("image-bulk [prompts...]")
  .description(
    `Generate images from multiple prompts in parallel

INPUT FORMATS
─────────────
1. CLI Arguments (simplest):
   image-bulk "a red circle" "a blue square" "a green triangle"

2. JSONL File (recommended for automation):
   image-bulk prompts.jsonl

   File format - one JSON object per line:
   {"prompt": "a red circle"}
   {"prompt": "a blue square", "size": "512x512"}
   {"prompt": "a green triangle", "quality": "hd"}

3. Text File (simple prompts only):
   image-bulk prompts.txt

   File format - one prompt per line:
   a red circle
   a blue square
   # comments start with #

4. JSON Array File:
   image-bulk prompts.json

   File format:
   ["a red circle", "a blue square"]

PROMPT OPTIONS (JSONL/JSON only)
────────────────────────────────
  prompt   (required) The image generation prompt
  size     Image size, e.g. "1024x1024" or "16:9"
  quality  "standard" or "hd"
  style    "natural" or "vivid"
  output   Custom output filename for this image

EXAMPLES
────────
  image-bulk "red circle" "blue square" -o ./images
  image-bulk prompts.jsonl --adapter gemini --dry-run
  image-bulk prompts.txt -c 5 --delay 1000`
  )
  .option("-a, --adapter <name>", "Media adapter (default: gemini)")
  .option("-s, --size <size>", "Default image size (default: 1024x1024)")
  .option("-q, --quality <quality>", "Quality: standard or hd")
  .option("--style <style>", "Style: natural or vivid")
  .option("-o, --output <path>", "Output directory for generated images")
  .option("-c, --concurrency <n>", "Number of parallel requests (default: 3)", (v) => {
    const n = parseInt(v, 10);
    if (isNaN(n) || n < 1) throw new Error("Concurrency must be a positive number");
    return n;
  })
  .option("--delay <ms>", "Delay (ms) per worker between requests (use --concurrency 1 for strict rate limiting)", (v) => {
    const n = parseInt(v, 10);
    if (isNaN(n) || n < 0) throw new Error("Delay must be a non-negative number");
    return n;
  })
  .option("--dry-run", "Show cost estimate without generating")
  .option("--max-cost <usd>", "Maximum total cost in USD", parseFloat)
  .option("--force", "Overwrite existing files")
  .option("--json", "Output as JSON")
  .action(wrapCommand((prompts, options) => bulkImageCommand(prompts, options)));

// === Audio Generation (TTS) ===

program
  .command("audio <text>")
  .description("Generate audio from text (text-to-speech)")
  .option("-a, --adapter <name>", "Media adapter (default: openai)")
  .option("-v, --voice <voice>", "Voice to use (default: alloy)")
  .option("-f, --format <format>", "Output format (default: mp3)")
  .option("--speed <speed>", "Speech speed 0.25-4.0", parseFloat)
  .option("-o, --output <path>", "Output file or directory")
  .option("--dry-run", "Show cost estimate without generating")
  .option("--max-cost <usd>", "Maximum cost in USD", parseFloat)
  .option("--force", "Overwrite existing files")
  .option("--json", "Output as JSON")
  .action(wrapCommand((text, options) => audioCommand(text, options)));

// === Video Generation ===

program
  .command("video [prompt]")
  .description("Generate a video from a text prompt (async operation)")
  .option("-a, --adapter <name>", "Media adapter (default: google)")
  .option("-d, --duration <seconds>", "Video duration in seconds", (v) => {
    const n = parseInt(v, 10);
    if (isNaN(n) || n < 1) throw new Error("Duration must be a positive number");
    return n;
  })
  .option("--aspect-ratio <ratio>", "Aspect ratio (e.g., 16:9)")
  .option("-o, --output <path>", "Output file or directory")
  .option("--dry-run", "Show cost estimate without generating")
  .option("--max-cost <usd>", "Maximum cost in USD", parseFloat)
  .option("--first-frame <path>", "Path to image file to use as first frame (image-to-video)")
  .option("--start", "Start generation and return job ID (for background agents)")
  .option("--check <jobId>", "Check status of a video job")
  .option("--download <jobId>", "Download a completed video")
  .option("--jobs", "List all video jobs")
  .option("--json", "Output as JSON")
  .action(wrapCommand((prompt, options) => videoCommand(prompt, options)));

// === Read / Understand Media ===

program
  .command("read <file>")
  .description(
    `Read and understand media content via AI (video/image/audio)

Review exit codes (--review):
  0  post       — ready to publish
  1  edit       — fixable issues, minor changes needed
  2  regenerate — fundamental problems, start over
  3  error`
  )
  .option("--review", "Review for virality — natural language critique + verdict (post/edit/regenerate)")
  .option("-a, --adapter <name>", "Read adapter (default: gemini)")
  .option("-t, --type <type>", "Media type: video, image, audio (auto-detected if omitted)")
  .option("-p, --platform <platform>", "Platform context: youtube-shorts, instagram-reels, general")
  .option(
    "--focus <brief>",
    "What this content is trying to achieve, in natural language.\n" +
    '    e.g. --focus "snappy hook that stops the scroll, builds tension, satisfying reveal at the end"'
  )
  .option("--json", "Output as JSON")
  .option("-o, --output <path>", "Save result to file")
  .action(wrapCommand((file, options) => readCommand(file, options)));

// === Video Post-Processing ===

program
  .command("merge-audio <video> <audio>")
  .description("Merge a silent video with a separate audio track")
  .requiredOption("-o, --output <path>", "Output file path")
  .option("--json", "Output as JSON")
  .action(wrapCommand((video, audio, options) => mergeAudioCommand(video, audio, options)));

program
  .command("assemble <clips...>")
  .description(
    `Combine video clips into one file

TRANSITIONS
───────────
  cut   (default) stream-copy, no re-encode, instant
  fade  crossfade dissolve with audio fade

--transition-duration <seconds>
  Duration of the fade overlap (default: 0.5)`
  )
  .requiredOption("-o, --output <path>", "Output file path")
  .option("--transition <type>", "Transition type (default: cut)", "cut")
  .option("--transition-duration <seconds>", "Transition duration in seconds", parseFloat)
  .option("--json", "Output as JSON")
  .action(wrapCommand((clips, options) => assembleCommand(clips, options)));

program
  .command("trim <video>")
  .description(
    `Remove silence and dead air from a video using ffmpeg silencedetect

Strips breath pauses, hesitations, and silent gaps between speech segments.
Useful for tightening TTS voiceovers or raw talking-head footage.

EXAMPLES
────────
  trim raw.mp4 -o tight.mp4
  trim raw.mp4 -o tight.mp4 --threshold -40 --min-silence 0.2
  trim raw.mp4 -o tight.mp4 --manifest cuts.json --json`
  )
  .requiredOption("-o, --output <path>", "Output file path")
  .option("--threshold <dB>", "Silence threshold in dB (default: -35)", parseFloat)
  .option("--min-silence <seconds>", "Minimum silence duration to cut (default: 0.3)", parseFloat)
  .option("--padding <seconds>", "Padding to keep around each speech segment (default: 0.05)", parseFloat)
  .option("--min-segment <seconds>", "Minimum segment length to keep (default: 0.2)", parseFloat)
  .option("--manifest <path>", "Write cut manifest JSON to this path")
  .option("--json", "Output result as JSON")
  .action(wrapCommand((video, options) => trimCommand(video, options)));

program
  .command("caption <video>")
  .description("Burn word-by-word captions using Whisper + ffmpeg")
  .requiredOption("-o, --output <path>", "Output file path")
  .option("--style <style>", "Caption style: word (default) or line", "word")
  .option("--font-name <name>", "Font name for captions (default: Liberation Sans)", "Liberation Sans")
  .option("--font-size <n>", "Font size in pixels (default: 14)", (v) => parseInt(v, 10), 14)
  .option("--position <pos>", "Caption position: top or bottom (default: bottom)", "bottom")
  .option("--color <color>", "Text color: named (black, white, yellow, red) or #RRGGBB (default: black)", "black")
  .option("--uppercase", "Render all caption text in ALL CAPS")
  .option("--outline-size <n>", "Border thickness 0–8 px, traces letter shapes (default: 2)", (v) => parseInt(v, 10), 2)
  .option("--outline-color <color>", "Border color: named or #RRGGBB (default: white)", "white")
  .option("--margin-v <n>", "Vertical margin from edge in pixels (default: 40)", (v) => parseInt(v, 10), 40)
  .option("--language <lang>", "BCP-47 language code for Whisper (default: en)", "en")
  .option("--whisper-prompt <text>", "Known script to improve Whisper accuracy on AI-TTS audio")
  .option("--keep-intermediates", "Save captions.ass and whisper-raw.json next to output")
  .option("--json", "Output as JSON")
  .action(wrapCommand((video, options) => captionCommand(video, options)));

program
  .command("frame <video>")
  .description("Place a video in a 1080x1920 (9:16) frame with a hook text banner")
  .requiredOption("-o, --output <path>", "Output file path")
  .requiredOption("--hook <text>", "Hook text displayed in the padding area")
  .option("--hook-position <pos>", "Where to show the hook: top or bottom (default: top)", "top")
  .option(
    "--video-scale <n>",
    "Fraction of frame height the video occupies, 0.1–0.95 (default: 0.70)",
    parseFloat
  )
  .option("--background <color>", "Background color: black or white (default: black)", "black")
  .option("--font-size <n>", "Hook text font size (default: 52)", (v) => parseInt(v, 10), 52)
  .option("--json", "Output as JSON")
  .action(wrapCommand((video, options) => frameCommand(video, options)));

// === Scrape ===

program
  .command("scrape <url>")
  .description(
    `Download a video or extract transcript from a social media URL

Supports YouTube, Instagram, and any platform yt-dlp handles.
No API keys required.

BEHAVIOR
────────
  Default          Download video to -o path (or scraped-<ts>.mp4)
  --transcript     Also extract captions (transcript-only if no -o given)

EXAMPLES
────────
  scrape "https://youtu.be/dQw4w9WgXcQ" -o video.mp4
  scrape "https://www.instagram.com/p/xxx/" -o reel.mp4
  scrape "https://youtu.be/dQw4w9WgXcQ" --transcript --json
  scrape "https://youtu.be/dQw4w9WgXcQ" --transcript -o video.mp4 --json`
  )
  .option("-o, --output <path>", "Output file path for video")
  .option("--transcript", "Extract captions/transcript")
  .option("--lang <code>", "Language code for transcript (default: en)", "en")
  .option("--json", "Output as JSON")
  .action(wrapCommand((url, options) => scrapeCommand(url, options)));

// === Utility Commands ===

program
  .command("list")
  .description("List available adapters")
  .option("-m, --modality <type>", "Filter by modality (image, video, audio)")
  .option("--json", "Output as JSON")
  .action(wrapCommand(async (options) => listCommand(options)));

program
  .command("capabilities <adapter>")
  .description("Show capabilities and pricing for an adapter")
  .option("--json", "Output as JSON")
  .action(wrapCommand(async (adapter, options) => capabilitiesCommand(adapter, options)));

program.parse();
