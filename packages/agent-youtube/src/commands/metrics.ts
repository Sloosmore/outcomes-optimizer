/**
 * metrics command - get video metrics
 */

import { adapterRegistry } from "../adapters/index.js";
import { EXIT_CODES } from "../config.js";

interface MetricsOptions {
  json?: boolean;
}

export async function metricsCommand(
  videoId: string,
  options: MetricsOptions
): Promise<void> {
  if (!videoId) {
    console.error("Error: Video ID required");
    process.exit(EXIT_CODES.INVALID_INPUT);
  }

  try {
    const adapter = adapterRegistry.get("youtube");
    const session = await adapter.restoreSession();
    const metrics = await session.getMetrics(videoId);

    if (options.json) {
      console.log(JSON.stringify(metrics, null, 2));
    } else {
      console.log(`Video: ${metrics.title}`);
      console.log(`Published: ${metrics.publishedAt} (${metrics.ageHours}h ago)`);
      console.log(`Views: ${metrics.views.toLocaleString()} (${metrics.viewsPerHour}/hr)`);
      console.log(`Likes: ${metrics.likes.toLocaleString()}`);
      console.log(`Comments: ${metrics.comments.toLocaleString()}`);
      console.log(`Engagement: ${metrics.engagementRate}%`);
    }
  } catch (error) {
    if (error instanceof Error) {
      if (error.message.includes("Not authenticated")) {
        console.error("Not authenticated. Run: agent-youtube auth");
        process.exit(EXIT_CODES.AUTH_REQUIRED);
      }
      console.error(`Failed to get metrics: ${error.message}`);
    } else {
      console.error("Failed to get metrics");
    }
    process.exit(EXIT_CODES.API_ERROR);
  }
}
