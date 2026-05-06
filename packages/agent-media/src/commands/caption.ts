/**
 * caption command — burn word-by-word captions using Whisper + ffmpeg
 *
 * Usage:
 *   agent-media caption <video> -o <output>
 *     [--style word|line]
 *     [--font-name <name>]
 *     [--font-size <n>]
 *     [--position top|bottom]
 *     [--color <color>]
 *     [--uppercase]
 *     [--outline-size <n>]
 *     [--outline-color <color>]
 *     [--margin-v <n>]
 *     [--whisper-prompt <text>]
 *     [--keep-intermediates]
 *     [--json]
 *
 * Pipeline:
 *   1. If video > 20 MB → extract audio to temp mp3; else send mp4 directly
 *   2. Whisper transcription with word-level timestamps
 *   3. Generate SRT from word timestamps
 *   4. Burn subtitles into video via ffmpeg
 *   5. Cleanup temp files (unless --keep-intermediates)
 */

import { stat, writeFile, unlink, copyFile, access, constants } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, basename, extname } from "node:path";
import { randomBytes } from "node:crypto";
import { checkFfmpeg, extractAudio, runFfmpeg } from "../utils/ffmpeg.js";
import { generateASS } from "../utils/srt.js";
import type { WordTimestamp, ASSStyle } from "../utils/srt.js";
import { getOpenAIApiKey } from "../utils/auth.js";
import { EXIT_CODES } from "../config.js";
import { getProxyFetch } from "../utils/fetch.js";

/** Max video size before we extract audio to avoid Whisper's 25 MB file limit */
const MAX_DIRECT_BYTES = 20 * 1024 * 1024;

/** Whisper API endpoint */
const WHISPER_URL = "https://api.openai.com/v1/audio/transcriptions";

const VALID_STYLES = ["word", "line"] as const;
const VALID_POSITIONS = ["top", "bottom"] as const;

/** Named colors → hex. Hex (#RRGGBB) also accepted directly. */
const NAMED_COLORS: Record<string, string> = {
  white: "#FFFFFF",
  black: "#000000",
  yellow: "#FFFF00",
  red: "#FF0000",
};

/**
 * Parse a color string (named or #RRGGBB) and return ASS &HAABBGGRR format.
 * Alpha is always 00 (fully opaque).
 */
function parseColor(color: string): string {
  const hex = NAMED_COLORS[color.toLowerCase()] ?? color;
  const match = hex.match(/^#?([0-9a-fA-F]{6})$/);
  if (!match) {
    throw new Error(
      `Invalid color "${color}". Use a named color (black, white, yellow, red) or #RRGGBB hex.`
    );
  }
  const r = match[1].slice(0, 2);
  const g = match[1].slice(2, 4);
  const b = match[1].slice(4, 6);
  return `&H00${b}${g}${r}`.toUpperCase();
}

export interface CaptionCommandOptions {
  output: string;
  style?: string;
  fontName?: string;
  fontSize?: number;
  position?: string;
  color?: string;
  uppercase?: boolean;
  outlineSize?: number;
  outlineColor?: string;
  marginV?: number;
  language?: string;
  whisperPrompt?: string;
  keepIntermediates?: boolean;
  json?: boolean;
}

interface WhisperWord {
  word: string;
  start: number;
  end: number;
}

interface WhisperResponse {
  words?: WhisperWord[];
  text?: string;
}

/** Build ASS style from caption options */
function buildASSStyle(options: CaptionCommandOptions & {
  primaryColour: string;
  outlineColour: string;
  fontSize: number;
  outlineSize: number;
  marginV: number;
}): ASSStyle {
  const fontName = options.fontName ?? "Liberation Sans";
  const alignment = options.position === "top" ? 8 : 2; // 8=top-center 2=bottom-center
  return {
    fontName,
    fontSize: options.fontSize,
    primaryColour: options.primaryColour,
    outlineColour: options.outlineColour,
    bold: true,
    outline: options.outlineSize,
    shadow: 0,
    alignment,
    marginV: options.marginV,
    borderStyle: 1, // character-tracing outline, not rectangular box
    uppercase: options.uppercase,
  };
}

/**
 * Escape a file path for use as an ffmpeg subtitles filter argument.
 * Only colons need escaping when the path is used as a plain filename= value
 * (not wrapped in force_style quotes).
 */
function escapeFfmpegFilterPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/:/g, "\\:");
}

async function transcribeWithWhisper(
  audioPath: string,
  apiKey: string,
  language: string,
  prompt?: string
): Promise<WordTimestamp[]> {
  const fetch = getProxyFetch(300_000);

  const form = new FormData();
  const { readFile } = await import("node:fs/promises");
  const data = await readFile(audioPath);
  const blob = new Blob([data]);
  form.append("file", blob, basename(audioPath));
  form.append("model", "whisper-1");
  form.append("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "word");
  form.append("language", language);
  if (prompt) {
    form.append("prompt", prompt);
  }

  const response = await fetch(WHISPER_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form as unknown as BodyInit,
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Whisper API error ${response.status}: ${body}`);
  }

  const json = (await response.json()) as WhisperResponse;
  const words = json.words ?? [];

  if (words.length === 0) {
    throw new Error(
      "Whisper returned no word-level timestamps. " +
        "The audio may be silent, too short, or the API did not honor timestamp_granularities[]=word."
    );
  }

  return words.map((w) => ({
    word: w.word.trim(),
    start: w.start,
    end: w.end,
  }));
}

export async function captionCommand(
  videoPath: string,
  options: CaptionCommandOptions
): Promise<void> {
  // --- Validate options ---
  const rawStyle = options.style ?? "word";
  if (!VALID_STYLES.includes(rawStyle as (typeof VALID_STYLES)[number])) {
    console.error(`Error: unknown --style "${rawStyle}". Valid: ${VALID_STYLES.join(", ")}`);
    process.exit(EXIT_CODES.CONFIG_ERROR);
  }
  const style = rawStyle as "word" | "line";

  const position = options.position ?? "bottom";
  if (!VALID_POSITIONS.includes(position as (typeof VALID_POSITIONS)[number])) {
    console.error(`Error: unknown --position "${position}". Valid: ${VALID_POSITIONS.join(", ")}`);
    process.exit(EXIT_CODES.CONFIG_ERROR);
  }

  let primaryColour: string;
  try {
    primaryColour = parseColor(options.color ?? "black");
  } catch (err) {
    console.error(`Error: --color ${err instanceof Error ? err.message : String(err)}`);
    process.exit(EXIT_CODES.CONFIG_ERROR);
  }

  let outlineColour: string;
  try {
    outlineColour = parseColor(options.outlineColor ?? "white");
  } catch (err) {
    console.error(`Error: --outline-color ${err instanceof Error ? err.message : String(err)}`);
    process.exit(EXIT_CODES.CONFIG_ERROR);
  }

  const fontSize = options.fontSize ?? 14;
  if (fontSize < 8 || fontSize > 200) {
    console.error("Error: --font-size must be between 8 and 200");
    process.exit(EXIT_CODES.CONFIG_ERROR);
  }

  const outlineSize = options.outlineSize ?? 2;
  if (!Number.isInteger(outlineSize) || outlineSize < 0 || outlineSize > 8) {
    console.error("Error: --outline-size must be an integer between 0 and 8");
    process.exit(EXIT_CODES.CONFIG_ERROR);
  }

  const marginV = options.marginV ?? 40;
  if (!Number.isInteger(marginV) || marginV < 0) {
    console.error("Error: --margin-v must be a non-negative integer");
    process.exit(EXIT_CODES.CONFIG_ERROR);
  }

  // --- Validate dependencies ---
  try {
    await checkFfmpeg();
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(EXIT_CODES.CONFIG_ERROR);
  }

  let apiKey: string;
  try {
    apiKey = getOpenAIApiKey();
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

  const tempFiles: string[] = [];

  try {
    // --- Step 1: Determine audio source ---
    let audioPath: string;
    const fileStats = await stat(videoPath);
    if (fileStats.size > MAX_DIRECT_BYTES) {
      audioPath = await extractAudio(videoPath);
      tempFiles.push(audioPath);
    } else {
      audioPath = videoPath;
    }

    // --- Step 2: Transcribe ---
    const words = await transcribeWithWhisper(audioPath, apiKey, options.language ?? "en", options.whisperPrompt);

    // --- Step 3: Generate ASS subtitle file (styling baked in, no force_style needed) ---
    const assStyle = buildASSStyle({ ...options, primaryColour, outlineColour, fontSize, outlineSize, marginV });
    const assContent = generateASS(words, style, assStyle);
    const assPath = join(
      tmpdir(),
      `agent-media-caps-${randomBytes(4).toString("hex")}.ass`
    );
    await writeFile(assPath, assContent, "utf-8");
    tempFiles.push(assPath);

    // --- Step 4: Burn subtitles ---
    // Using ASS avoids force_style escaping issues entirely.
    const escapedAss = escapeFfmpegFilterPath(assPath);
    await runFfmpeg([
      "-i", videoPath,
      "-vf", `subtitles=${escapedAss}`,
      "-c:a", "copy",
      options.output,
    ]);

    // --- Step 5: Optionally save intermediates ---
    if (options.keepIntermediates) {
      const outDir = dirname(options.output);
      const outBase = basename(options.output, extname(options.output));

      const savedAss = join(outDir, `${outBase}-captions.ass`);
      await copyFile(assPath, savedAss);

      const whisperJson = join(outDir, `${outBase}-whisper-raw.json`);
      await writeFile(whisperJson, JSON.stringify({ words }, null, 2), "utf-8");
    }

    const result = {
      file: options.output,
      words: words.length,
      style,
      ...(options.keepIntermediates ? { ass: assPath } : {}),
    };

    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`Saved: ${options.output} (${words.length} words)`);
    }
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(EXIT_CODES.COMPLETE_FAILURE);
  } finally {
    if (!options.keepIntermediates) {
      for (const f of tempFiles) {
        await unlink(f).catch(() => undefined);
      }
    }
  }
}
