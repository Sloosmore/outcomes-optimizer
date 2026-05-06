/**
 * frame command — place a video in a 9:16 frame with a hook text banner
 *
 * Usage:
 *   agent-media frame <video> -o <output>
 *     --hook <text>            Hook text displayed in the padding area (required)
 *     [--hook-position top|bottom]  Where to show the hook (default: top)
 *     [--video-scale <n>]      Fraction of frame height the video occupies, 0.1–0.95 (default: 0.70)
 *     [--background black|white]   Background color (default: black)
 *     [--font-size <n>]        Hook text font size (default: 52)
 *     [--json]
 *
 * Output is always 1080x1920 (9:16). Text color is always the inverse of background.
 */

import { access, constants } from "node:fs/promises";
import { checkFfmpeg, runFfmpeg } from "../utils/ffmpeg.js";
import { EXIT_CODES } from "../config.js";

const FRAME_WIDTH = 1080;
const FRAME_HEIGHT = 1920;
/** Horizontal margin subtracted from each side when computing word-wrap width */
const WRAP_MARGIN = 60;

export interface FrameCommandOptions {
  output: string;
  hook: string;
  hookPosition?: string;
  videoScale?: number;
  background?: string;
  fontSize?: number;
  json?: boolean;
}

/**
 * Word-wrap text to fit within maxWidth pixels.
 * Returns text with literal \n separating lines (ffmpeg drawtext newline syntax).
 *
 * Uses an approximate character width of 0.55 × fontSize for DejaVuSans-Bold.
 */
function wrapText(text: string, maxWidth: number, fontSize: number): string {
  const charWidth = fontSize * 0.55;
  const charsPerLine = Math.floor(maxWidth / charWidth);

  const words = text.split(" ");
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    if (!current) {
      current = word;
    } else if ((current + " " + word).length <= charsPerLine) {
      current += " " + word;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);

  // Use an actual newline character (0x0A). ffmpeg drawtext treats a literal
  // newline inside single-quoted text as a line break, whereas the escape
  // sequence \n (backslash+n) is rendered as the letter 'n'.
  return lines.join("\n");
}

/**
 * Escape text for use in an ffmpeg drawtext= filter value.
 * The -vf string uses single-quote delimiters, so we must escape
 * backslash, single-quote, colon, and percent.
 */
function escapeDrawtext(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/:/g, "\\:")
    .replace(/%/g, "\\%");
}

export async function frameCommand(
  videoPath: string,
  options: FrameCommandOptions
): Promise<void> {
  // --- Validate options ---
  const hookPosition = options.hookPosition ?? "top";
  if (hookPosition !== "top" && hookPosition !== "bottom") {
    console.error(`Error: --hook-position must be "top" or "bottom"`);
    process.exit(EXIT_CODES.CONFIG_ERROR);
  }

  const videoScale = options.videoScale ?? 0.7;
  if (videoScale < 0.1 || videoScale > 0.95) {
    console.error("Error: --video-scale must be between 0.1 and 0.95");
    process.exit(EXIT_CODES.CONFIG_ERROR);
  }

  const background = options.background ?? "black";
  if (background !== "black" && background !== "white") {
    console.error(`Error: --background must be "black" or "white"`);
    process.exit(EXIT_CODES.CONFIG_ERROR);
  }

  const fontSize = options.fontSize ?? 52;
  if (fontSize < 8 || fontSize > 200) {
    console.error("Error: --font-size must be between 8 and 200");
    process.exit(EXIT_CODES.CONFIG_ERROR);
  }

  const fontColor = background === "black" ? "white" : "black";
  const videoHeight = Math.floor(FRAME_HEIGHT * videoScale);
  const paddingHeight = FRAME_HEIGHT - videoHeight;

  // --- Validate dependencies ---
  try {
    await checkFfmpeg();
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(EXIT_CODES.CONFIG_ERROR);
  }

  // --- Validate input file ---
  try {
    await access(videoPath, constants.R_OK);
  } catch {
    console.error(`Error: File not found or not readable: ${videoPath}`);
    process.exit(EXIT_CODES.FILE_ERROR);
  }

  // --- Build filter chain ---
  // Escape special chars first, THEN wrap — so the \n separators added by
  // wrapText are not subsequently double-escaped into \\n (which ffmpeg would
  // render as a literal backslash + 'n' rather than a line break).
  const usableWidth = FRAME_WIDTH - WRAP_MARGIN * 2;
  const escapedHook = wrapText(escapeDrawtext(options.hook), usableWidth, fontSize);

  // padY: vertical offset of the scaled video within the 1080×1920 canvas
  // textY: vertical position of the hook text so it is centered in its padding band
  let padY: string;
  let textY: string;

  if (hookPosition === "top") {
    // Hook above, video below → place video flush to the bottom
    padY = "(oh-ih)";
    textY = `(${paddingHeight}-text_h)/2`;
  } else {
    // Video above, hook below → place video flush to the top
    padY = "0";
    textY = `${videoHeight}+(${paddingHeight}-text_h)/2`;
  }

  const vf = [
    `scale=${FRAME_WIDTH}:${videoHeight}:force_original_aspect_ratio=decrease`,
    `pad=${FRAME_WIDTH}:${FRAME_HEIGHT}:(ow-iw)/2:${padY}:${background}`,
    `drawtext=text='${escapedHook}':x=(w-text_w)/2:y=${textY}:fontsize=${fontSize}:fontcolor=${fontColor}:font=DejaVuSans-Bold:line_spacing=12`,
  ].join(",");

  // --- Run ffmpeg ---
  try {
    await runFfmpeg(["-i", videoPath, "-vf", vf, "-c:a", "copy", options.output]);

    const result = {
      file: options.output,
      hook: options.hook,
      hookPosition,
      videoScale,
      background,
      fontSize,
      fontColor,
    };

    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`Saved: ${options.output}`);
    }
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(EXIT_CODES.COMPLETE_FAILURE);
  }
}
