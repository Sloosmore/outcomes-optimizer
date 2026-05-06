import { loadState } from "../state/inbox.js";
import { waitForEmail } from "../utils/poll.js";
import { getSession } from "./index.js";

export interface WaitCommandOptions {
  timeout?: string;
  from?: string;
  subject?: string;
  json?: boolean;
}

/**
 * Wait for a new email matching criteria
 */
export async function waitCommand(options: WaitCommandOptions): Promise<void> {
  const state = await loadState();

  if (!state) {
    console.error("Error: No inbox initialized. Run 'throwmail init' first.");
    process.exit(1);
  }

  const session = getSession(state);
  const timeout = options.timeout ? parseInt(options.timeout, 10) : 60;

  if (isNaN(timeout) || timeout <= 0 || (options.timeout && !/^\d+$/.test(options.timeout))) {
    console.error("Error: Invalid timeout value - must be a positive integer");
    process.exit(1);
  }

  try {
    const email = await waitForEmail(session, {
      timeout,
      from: options.from,
      subject: options.subject,
      seenIds: state.seenIds,
    });

    if (options.json) {
      console.log(JSON.stringify(email, null, 2));
      return;
    }

    // Print summary
    console.log(`Email received from "${email.from}"`);
    console.log(`Subject: ${email.subject}`);
    console.log(`ID: ${email.id}`);
  } catch (error) {
    if (error instanceof Error) {
      console.error(`Error: ${error.message}`);
    } else {
      console.error("Error waiting for email");
    }
    process.exit(1);
  }
}
