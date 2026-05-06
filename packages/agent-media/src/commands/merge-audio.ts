/**
 * merge-audio command — fuse a silent video with a separate audio track
 *
 * Usage:
 *   agent-media merge-audio <video> <audio> -o <output> [--json]
 *
 * The shortest stream determines the output duration (-shortest), which
 * gracefully handles minor TTS/video length mismatches.
 */

import { checkFfmpeg, runFfmpeg } from "../utils/ffmpeg.js";
import { EXIT_CODES } from "../config.js";

export interface MergeAudioCommandOptions {
  output: string;
  json?: boolean;
}

export async function mergeAudioCommand(
  videoPath: string,
  audioPath: string,
  options: MergeAudioCommandOptions
): Promise<void> {
  try {
    await checkFfmpeg();
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(EXIT_CODES.CONFIG_ERROR);
  }

  try {
    await runFfmpeg([
      "-i", videoPath,
      "-i", audioPath,
      "-map", "0:v",
      "-map", "1:a",
      "-c:v", "copy",
      "-c:a", "aac",
      "-shortest",
      options.output,
    ]);
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(EXIT_CODES.COMPLETE_FAILURE);
  }

  const result = {
    file: options.output,
    videoSource: videoPath,
    audioSource: audioPath,
  };

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`Saved: ${options.output}`);
  }
}
