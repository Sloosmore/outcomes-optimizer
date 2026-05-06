import { loadSession } from "../state/session.js";
import { getSession } from "./index.js";
import { printOutput, exitWithError } from "../utils/output.js";

export interface StatusCommandOptions {
  json?: boolean;
}

/**
 * Check the status of a post/upload
 */
export async function statusCommand(
  postId: string,
  options: StatusCommandOptions
): Promise<void> {
  const state = await loadSession();

  if (!state) {
    exitWithError("No session found. Run 'agent-instagram login' first.");
    return;
  }

  const session = getSession(state);

  try {
    const status = await session.getPostStatus(postId);

    if (options.json) {
      printOutput(status, true);
    } else {
      console.log(`Post ID: ${status.id}`);
      console.log(`Status: ${status.status}`);
      if (status.statusCode) {
        console.log(`Status Code: ${status.statusCode}`);
      }
      if (status.errorMessage) {
        console.log(`Error: ${status.errorMessage}`);
      }
    }
  } catch (error) {
    if (error instanceof Error) {
      exitWithError(error.message);
    }
    exitWithError("Failed to check post status");
  }
}
