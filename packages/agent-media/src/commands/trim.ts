/**
 * trim command — intelligently remove silence and dead air from video
 *
 * Usage:
 *   agent-media trim <video> -o <output>
 *     [--threshold <dB>]         silence detection threshold (default: -35)
 *     [--min-silence <seconds>]  min silence duration to cut (default: 0.3)
 *     [--padding <seconds>]      keep this much audio around each segment (default: 0.05)
 *     [--min-segment <seconds>]  drop speech segments shorter than this (default: 0.2)
 *     [--manifest <path>]        also write cut manifest JSON to this path
 *     [--json]
 *
 * How it works:
 *   1. ffmpeg silencedetect finds all silent regions
 *   2. Invert to get speech segments
 *   3. Apply padding so we don't clip consonants at boundaries
 *   4. Merge segments where the gap between them is < padding (avoids micro-cuts)
 *   5. Build a filter_complex with trim+setpts+concat and run it
 */

import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { writeFile, access, constants } from "node:fs/promises";
import { checkFfmpeg, getDuration, runFfmpeg } from "../utils/ffmpeg.js";
import { EXIT_CODES } from "../config.js";

const execFile = promisify(execFileCb);

export interface TrimCommandOptions {
  output: string;
  threshold?: number;   // dB, e.g. -35
  minSilence?: number;  // seconds
  padding?: number;     // seconds
  minSegment?: number;  // seconds
  manifest?: string;    // path to write manifest JSON
  json?: boolean;
}

export interface CutSegment {
  start: number;
  end: number;
  duration: number;
}

export interface TrimManifest {
  input: string;
  output: string;
  originalDuration: number;
  trimmedDuration: number;
  segments: CutSegment[];
  removedSeconds: number;
}

/** Run ffmpeg silencedetect and return stderr output */
async function detectSilence(
  filePath: string,
  threshold: number,
  minDuration: number
): Promise<string> {
  // Need the raw stderr — use execFile with the system ffmpeg binary
  // (silencedetect doesn't need libass, system ffmpeg is fine)
  let stderr: string;
  try {
    const staticPath = "/tmp/ffmpeg-full/ffmpeg";
    const { existsSync } = await import("node:fs");
    const bin = existsSync(staticPath) ? staticPath : "ffmpeg";
    ({ stderr } = await execFile(bin, [
      "-i", filePath,
      "-af", `silencedetect=noise=${threshold}dB:d=${minDuration}`,
      "-f", "null",
      "-",
    ]));
  } catch (err: unknown) {
    // ffmpeg exits 0 even on success for -f null; the output is in stderr
    // If it's a real error (not just "no such file"), rethrow
    const e = err as { stderr?: string; code?: number };
    if (e.stderr && e.stderr.includes("silencedetect")) {
      stderr = e.stderr;
    } else {
      throw err;
    }
  }
  return stderr;
}

/** Parse silencedetect stderr into silence intervals */
function parseSilences(stderr: string): Array<{ start: number; end: number }> {
  const silences: Array<{ start?: number; end?: number }> = [];

  for (const line of stderr.split("\n")) {
    const startMatch = line.match(/silence_start:\s*([\d.]+)/);
    const endMatch = line.match(/silence_end:\s*([\d.]+)/);

    if (startMatch) {
      silences.push({ start: parseFloat(startMatch[1]) });
    } else if (endMatch && silences.length > 0) {
      const last = silences[silences.length - 1];
      if (last.end === undefined) {
        last.end = parseFloat(endMatch[1]);
      }
    }
  }

  // Close any trailing silence that runs to end of file
  return silences.filter((s) => s.start !== undefined) as Array<{
    start: number;
    end: number;
  }>;
}

/** Convert silence intervals to speech segments with padding */
function silencesToSegments(
  silences: Array<{ start: number; end?: number }>,
  totalDuration: number,
  padding: number,
  minSegment: number
): CutSegment[] {
  // Build the inverse: regions that are NOT silence
  const raw: Array<{ start: number; end: number }> = [];

  if (silences.length === 0) {
    // No silence found — return whole clip
    return [{ start: 0, end: totalDuration, duration: totalDuration }];
  }

  // Region before first silence
  const firstSilenceStart = silences[0].start ?? 0;
  if (firstSilenceStart > 0) {
    raw.push({ start: 0, end: firstSilenceStart });
  }

  // Regions between silences
  for (let i = 0; i < silences.length - 1; i++) {
    const segStart = silences[i].end ?? silences[i].start;
    const segEnd = silences[i + 1].start ?? totalDuration;
    if (segEnd > segStart) {
      raw.push({ start: segStart, end: segEnd });
    }
  }

  // Region after last silence
  const lastSilenceEnd = silences[silences.length - 1].end ?? totalDuration;
  if (lastSilenceEnd < totalDuration) {
    raw.push({ start: lastSilenceEnd, end: totalDuration });
  }

  // Apply padding and clamp to [0, totalDuration]
  const padded = raw.map((seg) => ({
    start: Math.max(0, seg.start - padding),
    end: Math.min(totalDuration, seg.end + padding),
  }));

  // Merge overlapping/adjacent segments
  const merged: Array<{ start: number; end: number }> = [];
  for (const seg of padded) {
    if (merged.length > 0 && seg.start <= merged[merged.length - 1].end) {
      merged[merged.length - 1].end = Math.max(
        merged[merged.length - 1].end,
        seg.end
      );
    } else {
      merged.push({ ...seg });
    }
  }

  // Filter out segments too short to be useful
  return merged
    .filter((seg) => seg.end - seg.start >= minSegment)
    .map((seg) => ({
      start: seg.start,
      end: seg.end,
      duration: seg.end - seg.start,
    }));
}

/** Build ffmpeg args to extract and concatenate speech segments */
function buildConcatArgs(
  inputPath: string,
  segments: CutSegment[],
  outputPath: string
): string[] {
  if (segments.length === 1) {
    // Single segment — simple trim, no concat needed
    const { start, end } = segments[0];
    return [
      "-i", inputPath,
      "-ss", start.toFixed(3),
      "-to", end.toFixed(3),
      "-c:v", "libx264",
      "-c:a", "aac",
      outputPath,
    ];
  }

  const filterParts: string[] = [];
  const concatInputs: string[] = [];

  for (let i = 0; i < segments.length; i++) {
    const { start, end } = segments[i];
    filterParts.push(
      `[0:v]trim=start=${start.toFixed(3)}:end=${end.toFixed(3)},setpts=PTS-STARTPTS[v${i}]`
    );
    filterParts.push(
      `[0:a]atrim=start=${start.toFixed(3)}:end=${end.toFixed(3)},asetpts=PTS-STARTPTS[a${i}]`
    );
    concatInputs.push(`[v${i}][a${i}]`);
  }

  filterParts.push(
    `${concatInputs.join("")}concat=n=${segments.length}:v=1:a=1[vout][aout]`
  );

  return [
    "-i", inputPath,
    "-filter_complex", filterParts.join(";"),
    "-map", "[vout]",
    "-map", "[aout]",
    outputPath,
  ];
}

export async function trimCommand(
  videoPath: string,
  options: TrimCommandOptions
): Promise<void> {
  // Validate input
  try {
    await access(videoPath, constants.R_OK);
  } catch {
    console.error(`Error: File not found or not readable: ${videoPath}`);
    process.exit(EXIT_CODES.FILE_ERROR);
  }

  try {
    await checkFfmpeg();
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(EXIT_CODES.CONFIG_ERROR);
  }

  const threshold = options.threshold ?? -35;
  const minSilence = options.minSilence ?? 0.3;
  const padding = options.padding ?? 0.05;
  const minSegment = options.minSegment ?? 0.2;

  try {
    // Step 1: Get total duration
    const totalDuration = await getDuration(videoPath);

    // Step 2: Detect silence
    const stderr = await detectSilence(videoPath, threshold, minSilence);
    const silences = parseSilences(stderr);

    // Step 3: Compute speech segments
    const segments = silencesToSegments(
      silences,
      totalDuration,
      padding,
      minSegment
    );

    if (segments.length === 0) {
      console.error("Error: no speech segments found — video may be entirely silent");
      process.exit(EXIT_CODES.FILE_ERROR);
    }

    // Step 4: Assemble trimmed video
    const args = buildConcatArgs(videoPath, segments, options.output);
    await runFfmpeg(args);

    // Step 5: Build manifest
    const trimmedDuration = segments.reduce((s, seg) => s + seg.duration, 0);
    const manifest: TrimManifest = {
      input: videoPath,
      output: options.output,
      originalDuration: totalDuration,
      trimmedDuration,
      segments,
      removedSeconds: totalDuration - trimmedDuration,
    };

    // Step 6: Optionally write manifest
    if (options.manifest) {
      await writeFile(options.manifest, JSON.stringify(manifest, null, 2), "utf-8");
    }

    // Step 7: Output
    if (options.json) {
      console.log(JSON.stringify(manifest, null, 2));
    } else {
      const pct = ((manifest.removedSeconds / totalDuration) * 100).toFixed(0);
      console.log(
        `Saved: ${options.output} ` +
          `(${segments.length} segments, removed ${manifest.removedSeconds.toFixed(1)}s / ${pct}% silence)`
      );
    }
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(EXIT_CODES.COMPLETE_FAILURE);
  }
}
