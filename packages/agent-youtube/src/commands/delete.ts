/**
 * delete command - delete a video
 */

import { adapterRegistry } from "../adapters/index.js";
import { EXIT_CODES } from "../config.js";

interface DeleteOptions {
  json?: boolean;
}

export async function deleteCommand(
  videoId: string,
  options: DeleteOptions
): Promise<void> {
  if (!videoId) {
    console.error("Error: Video ID required");
    process.exit(EXIT_CODES.INVALID_INPUT);
  }

  try {
    const adapter = adapterRegistry.get("youtube");
    const session = await adapter.restoreSession();
    await session.delete(videoId);

    if (options.json) {
      console.log(JSON.stringify({ deleted: true, videoId }));
    } else {
      console.log(`Deleted video: ${videoId}`);
    }
  } catch (error) {
    if (error instanceof Error) {
      if (error.message.includes("Not authenticated")) {
        console.error("Not authenticated. Run: agent-youtube auth");
        process.exit(EXIT_CODES.AUTH_REQUIRED);
      }
      console.error(`Failed to delete video: ${error.message}`);
    } else {
      console.error("Failed to delete video");
    }
    process.exit(EXIT_CODES.API_ERROR);
  }
}
