/**
 * Shared ffmpeg/ffprobe helpers for agent-media commands.
 *
 * All commands that invoke ffmpeg should use these helpers rather than
 * spawning their own subprocesses — this keeps subprocess error handling
 * and install-hint messages in one place.
 */

import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";

const execFile = promisify(execFileCb);

/**
 * Locate the ffmpeg binary, preferring a full-featured static build over
 * the system ffmpeg if one is present at the well-known evermeet.cx install path.
 */
function ffmpegBin(): string {
  const staticPath = "/tmp/ffmpeg-full/ffmpeg";
  if (existsSync(staticPath)) return staticPath;
  return "ffmpeg";
}

function ffprobeBin(): string {
  return "ffprobe";
}

/**
 * Throw a helpful error if ffmpeg or ffprobe are not installed.
 */
export async function checkFfmpeg(): Promise<void> {
  try {
    await execFile(ffmpegBin(), ["-version"]);
  } catch {
    throw new Error(
      "ffmpeg not found. Install it with:\n" +
        "  macOS:  brew install ffmpeg\n" +
        "  Ubuntu: sudo apt-get install -y ffmpeg\n" +
        "  Windows: https://ffmpeg.org/download.html"
    );
  }
}

/**
 * Return the video dimensions of a media file via ffprobe.
 */
export async function getVideoSize(filePath: string): Promise<{ width: number; height: number }> {
  let stdout: string;
  try {
    ({ stdout } = await execFile(ffprobeBin(), [
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "stream=width,height",
      "-of", "csv=s=x:p=0",
      filePath,
    ]));
  } catch (err) {
    throw new Error(
      `ffprobe failed for "${filePath}": ${err instanceof Error ? err.message : String(err)}`
    );
  }
  const [w, h] = stdout.trim().split("x").map(Number);
  if (!w || !h || isNaN(w) || isNaN(h)) {
    throw new Error(`Could not parse video dimensions from ffprobe: "${stdout.trim()}"`);
  }
  return { width: w, height: h };
}

/**
 * Return the duration of a media file in seconds via ffprobe.
 */
export async function getDuration(filePath: string): Promise<number> {
  let stdout: string;
  try {
    ({ stdout } = await execFile(ffprobeBin(), [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      filePath,
    ]));
  } catch (err) {
    throw new Error(
      `ffprobe failed for "${filePath}": ${err instanceof Error ? err.message : String(err)}`
    );
  }

  const secs = parseFloat(stdout.trim());
  if (isNaN(secs)) {
    throw new Error(`Could not parse duration from ffprobe output: "${stdout.trim()}"`);
  }
  return secs;
}

/**
 * Run ffmpeg with the given argument list.
 * Prepends -y so ffmpeg never prompts for overwrite confirmation.
 */
export async function runFfmpeg(args: string[]): Promise<void> {
  try {
    await execFile(ffmpegBin(), ["-y", ...args]);
  } catch (err) {
    // execFile rejects with the stderr in err.message when ffmpeg exits non-zero
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`ffmpeg failed: ${msg}`);
  }
}

/**
 * Extract the audio track from a video to a temp mp3 file.
 * Returns the path to the temp file — caller is responsible for cleanup.
 */
export async function extractAudio(videoPath: string): Promise<string> {
  const tempPath = join(tmpdir(), `agent-media-audio-${randomBytes(4).toString("hex")}.mp3`);
  await runFfmpeg(["-i", videoPath, "-vn", "-acodec", "libmp3lame", "-q:a", "2", tempPath]);
  return tempPath;
}
