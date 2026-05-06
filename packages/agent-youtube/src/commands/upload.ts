/**
 * upload command - upload a video as a YouTube Short
 */

import { adapterRegistry } from "../adapters/index.js";
import { EXIT_CODES } from "../config.js";

interface UploadOptions {
  title: string;
  description?: string;
  tags?: string;
  privacy?: "public" | "unlisted" | "private";
  json?: boolean;
}

export async function uploadCommand(
  file: string,
  options: UploadOptions
): Promise<void> {
  // Validate inputs
  if (!file) {
    console.error("Error: Video file path required");
    process.exit(EXIT_CODES.INVALID_INPUT);
  }

  if (!options.title) {
    console.error("Error: --title is required");
    process.exit(EXIT_CODES.INVALID_INPUT);
  }

  try {
    const adapter = adapterRegistry.get("youtube");
    const session = await adapter.restoreSession();

    const result = await session.upload({
      file,
      title: options.title,
      description: options.description,
      tags: options.tags?.split(",").map((t) => t.trim()),
      privacy: options.privacy,
    });

    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`Uploaded: ${result.title}`);
      console.log(`Video ID: ${result.videoId}`);
      console.log(`URL: ${result.shortsUrl}`);
      console.log(`Quota used: ${result.quotaUsed} units`);
    }
  } catch (error) {
    if (error instanceof Error) {
      if (error.message.includes("Not authenticated")) {
        console.error("Not authenticated. Run: agent-youtube auth");
        process.exit(EXIT_CODES.AUTH_REQUIRED);
      }
      if (error.message.includes("Quota exceeded")) {
        console.error(error.message);
        process.exit(EXIT_CODES.QUOTA_EXCEEDED);
      }
      console.error(`Upload failed: ${error.message}`);
    } else {
      console.error("Upload failed");
    }
    process.exit(EXIT_CODES.API_ERROR);
  }
}
