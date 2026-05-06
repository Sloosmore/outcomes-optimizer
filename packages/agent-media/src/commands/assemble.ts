/**
 * assemble command — combine multiple video clips into one file
 *
 * Usage:
 *   agent-media assemble <clips...> -o <output>
 *     [--transition cut|fade]
 *     [--transition-duration <seconds>]
 *     [--json]
 *
 * Transitions:
 *   cut  (default) — stream-copy concat, instant, no re-encode
 *   fade — crossfade dissolve with audio fade, 0.5s overlap
 */

import { writeFile, unlink, access, constants } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { checkFfmpeg, getDuration, runFfmpeg } from "../utils/ffmpeg.js";
import { EXIT_CODES } from "../config.js";

export const VALID_TRANSITIONS = ["cut", "fade"] as const;
export type Transition = (typeof VALID_TRANSITIONS)[number];

export interface AssembleCommandOptions {
  output: string;
  transition?: string;
  transitionDuration?: number;
  json?: boolean;
}

async function validateFileReadable(filePath: string): Promise<void> {
  try {
    await access(filePath, constants.R_OK);
  } catch {
    throw new Error(`File not found or not readable: ${filePath}`);
  }
}

/**
 * Build a fade xfade + acrossfade filter_complex for N clips.
 * Each adjacent pair overlaps by `tz` seconds with a crossfade.
 */
async function buildFadeArgs(
  clips: string[],
  tz: number,
  outputPath: string,
): Promise<string[]> {
  const durations = await Promise.all(clips.map(getDuration));

  for (let i = 0; i < clips.length; i++) {
    if (durations[i] <= tz) {
      throw new Error(
        `Clip "${clips[i]}" is ${durations[i].toFixed(2)}s, shorter than the ` +
          `${tz}s fade overlap. Use --transition cut or provide longer clips.`,
      );
    }
  }

  const filterParts: string[] = [];
  let lastV = "[0:v]";
  let lastA = "[0:a]";
  let timeOffset = 0;

  for (let i = 1; i < clips.length; i++) {
    timeOffset += durations[i - 1] - tz;
    const isLast = i === clips.length - 1;
    const vTag = isLast ? "[vout]" : `[v${i}]`;
    const aTag = isLast ? "[aout]" : `[a${i}]`;
    filterParts.push(
      `${lastV}[${i}:v]xfade=transition=fade:duration=${tz.toFixed(3)}:offset=${timeOffset.toFixed(3)}${vTag}`,
    );
    filterParts.push(`${lastA}[${i}:a]acrossfade=d=${tz.toFixed(3)}${aTag}`);
    lastV = vTag;
    lastA = aTag;
  }

  const inputArgs = clips.flatMap((c) => ["-i", c]);
  return [
    ...inputArgs,
    "-filter_complex", filterParts.join(";"),
    "-map", "[vout]",
    "-map", "[aout]",
    outputPath,
  ];
}

/** Run the assembly for the given transition type */
async function runAssembly(
  clips: string[],
  transition: Transition,
  transitionDuration: number,
  outPath: string,
): Promise<void> {
  if (transition === "cut") {
    const filelistPath = join(
      tmpdir(),
      `agent-media-filelist-${randomBytes(4).toString("hex")}.txt`,
    );
    const filelistContent = clips
      .map((c) => `file '${resolve(c).replace(/'/g, "'\\''")}'`)
      .join("\n");
    await writeFile(filelistPath, filelistContent, "utf-8");
    try {
      await runFfmpeg(["-f", "concat", "-safe", "0", "-i", filelistPath, "-c", "copy", outPath]);
    } finally {
      await unlink(filelistPath).catch(() => undefined);
    }
    return;
  }

  // fade
  const args = await buildFadeArgs(clips, transitionDuration, outPath);
  await runFfmpeg(args);
}

export async function assembleCommand(
  clips: string[],
  options: AssembleCommandOptions,
): Promise<void> {
  if (clips.length < 2) {
    console.error("Error: assemble requires at least 2 clips");
    process.exit(EXIT_CODES.FILE_ERROR);
  }

  const transition = (options.transition ?? "cut") as Transition;
  if (!VALID_TRANSITIONS.includes(transition)) {
    console.error(
      `Error: unknown transition "${transition}". Valid options: ${VALID_TRANSITIONS.join(", ")}`,
    );
    process.exit(EXIT_CODES.CONFIG_ERROR);
  }

  const transitionDuration = options.transitionDuration ?? 0.5;

  try {
    await checkFfmpeg();
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(EXIT_CODES.CONFIG_ERROR);
  }

  try {
    for (const clip of clips) {
      await validateFileReadable(clip);
    }
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(EXIT_CODES.FILE_ERROR);
  }

  try {
    await runAssembly(clips, transition, transitionDuration, options.output);
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(EXIT_CODES.COMPLETE_FAILURE);
  }

  const result = { file: options.output, clips, transition };

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`Saved: ${options.output}`);
  }
}
