/**
 * list command - list recent uploads
 */

import { adapterRegistry } from "../adapters/index.js";
import { EXIT_CODES } from "../config.js";

interface ListOptions {
  limit?: number;
  since?: string;
  json?: boolean;
}

export async function listCommand(options: ListOptions): Promise<void> {
  try {
    const adapter = adapterRegistry.get("youtube");
    const session = await adapter.restoreSession();
    const videos = await session.listVideos({
      limit: options.limit,
      since: options.since,
    });

    if (options.json) {
      console.log(JSON.stringify(videos, null, 2));
    } else {
      if (videos.length === 0) {
        console.log("No videos found.");
        return;
      }

      console.log(`Recent uploads (${videos.length}):\n`);
      for (const video of videos) {
        const age = getAge(video.publishedAt);
        console.log(`${video.videoId}  ${video.views.toLocaleString().padStart(8)} views  ${age.padStart(8)}  ${video.title}`);
      }
    }
  } catch (error) {
    if (error instanceof Error) {
      if (error.message.includes("Not authenticated")) {
        console.error("Not authenticated. Run: agent-youtube auth");
        process.exit(EXIT_CODES.AUTH_REQUIRED);
      }
      console.error(`Failed to list videos: ${error.message}`);
    } else {
      console.error("Failed to list videos");
    }
    process.exit(EXIT_CODES.API_ERROR);
  }
}

function getAge(isoDate: string): string {
  const ms = Date.now() - new Date(isoDate).getTime();
  const hours = Math.floor(ms / (1000 * 60 * 60));
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  return `${weeks}w ago`;
}
