import { loadSession } from "../state/session.js";
import { getSession } from "./index.js";
import { printOutput, exitWithError } from "../utils/output.js";
import { MAX_CAPTION_LENGTH } from "../config.js";

export interface PostPhotoOptions {
  image: string;
  caption?: string;
  json?: boolean;
}

export interface PostVideoOptions {
  video: string;
  caption?: string;
  cover?: string;
  json?: boolean;
}

export interface PostReelOptions {
  video: string;
  caption?: string;
  cover?: string;
  shareToFeed?: boolean;
  json?: boolean;
}

/**
 * Validate caption length
 */
function validateCaption(caption?: string): void {
  if (caption && caption.length > MAX_CAPTION_LENGTH) {
    exitWithError(
      `Caption exceeds maximum length of ${MAX_CAPTION_LENGTH} characters (got ${caption.length})`
    );
  }
}

/**
 * Ensure a session is loaded or exit
 */
async function requireSession() {
  const state = await loadSession();
  if (!state) {
    exitWithError("No session found. Run 'agent-instagram login' first.");
    return undefined as never;
  }
  return getSession(state);
}

/**
 * Post a photo to Instagram
 */
export async function postPhotoCommand(options: PostPhotoOptions): Promise<void> {
  validateCaption(options.caption);
  const session = await requireSession();

  try {
    const result = await session.postPhoto({
      imageUrl: options.image,
      caption: options.caption,
    });

    if (options.json) {
      printOutput(result, true);
    } else {
      console.log(`Photo published (ID: ${result.id})`);
      if (result.message) {
        console.log(result.message);
      }
    }
  } catch (error) {
    if (error instanceof Error) {
      exitWithError(error.message);
    }
    exitWithError("Failed to post photo");
  }
}

/**
 * Post a video to Instagram
 */
export async function postVideoCommand(options: PostVideoOptions): Promise<void> {
  validateCaption(options.caption);
  const session = await requireSession();

  try {
    const result = await session.postVideo({
      videoUrl: options.video,
      caption: options.caption,
      coverUrl: options.cover,
    });

    if (options.json) {
      printOutput(result, true);
    } else {
      console.log(`Video published (ID: ${result.id})`);
      if (result.message) {
        console.log(result.message);
      }
    }
  } catch (error) {
    if (error instanceof Error) {
      exitWithError(error.message);
    }
    exitWithError("Failed to post video");
  }
}

/**
 * Post a reel to Instagram
 */
export async function postReelCommand(options: PostReelOptions): Promise<void> {
  validateCaption(options.caption);
  const session = await requireSession();

  try {
    const result = await session.postReel({
      videoUrl: options.video,
      caption: options.caption,
      coverUrl: options.cover,
      shareToFeed: options.shareToFeed,
    });

    if (options.json) {
      printOutput(result, true);
    } else {
      console.log(`Reel published (ID: ${result.id})`);
      if (result.message) {
        console.log(result.message);
      }
    }
  } catch (error) {
    if (error instanceof Error) {
      exitWithError(error.message);
    }
    exitWithError("Failed to post reel");
  }
}

/**
 * Dispatch post subcommand
 */
export async function postCommand(
  type: string,
  options: PostPhotoOptions & PostVideoOptions & PostReelOptions
): Promise<void> {
  switch (type) {
    case "photo":
      if (!options.image) {
        exitWithError("--image is required for photo posts");
      }
      return postPhotoCommand(options);
    case "video":
      if (!options.video) {
        exitWithError("--video is required for video posts");
      }
      return postVideoCommand(options);
    case "reel":
      if (!options.video) {
        exitWithError("--video is required for reel posts");
      }
      return postReelCommand(options);
    default:
      exitWithError(`Unknown post type: "${type}". Use photo, video, or reel.`);
  }
}
