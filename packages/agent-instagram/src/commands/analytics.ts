import { loadSession } from "../state/session.js";
import { getSession } from "./index.js";
import { printOutput, exitWithError } from "../utils/output.js";

export interface AnalyticsCommandOptions {
  json?: boolean;
}

/**
 * Get and display analytics/insights for a media post
 */
export async function analyticsCommand(
  postId: string,
  options: AnalyticsCommandOptions
): Promise<void> {
  const state = await loadSession();

  if (!state) {
    exitWithError("No session found. Run 'agent-instagram login' first.");
    return;
  }

  const session = getSession(state);

  try {
    const insights = await session.getMediaInsights(postId);

    if (options.json) {
      printOutput(insights, true);
    } else {
      console.log(`reach: ${insights.reach}`);
      console.log(`video views: ${insights.videoViews ?? 0}`);
      console.log(`saved: ${insights.saved}`);
      console.log(`likes: ${insights.likes}`);
      console.log(`comments: ${insights.comments}`);
      console.log(`shares: ${insights.shares}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to fetch analytics";
    exitWithError(message);
  }
}
