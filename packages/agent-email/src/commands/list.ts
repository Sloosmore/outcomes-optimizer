import { loadState } from "../state/inbox.js";
import { getSession } from "./index.js";

export interface ListCommandOptions {
  from?: string;
  json?: boolean;
}

/**
 * List emails in the current inbox
 */
export async function listCommand(options: ListCommandOptions): Promise<void> {
  const state = await loadState();

  if (!state) {
    console.error("Error: No inbox initialized. Run 'throwmail init' first.");
    process.exit(1);
  }

  const session = getSession(state);

  try {
    let emails = await session.list();

    // Filter by sender if specified
    if (options.from) {
      const fromFilter = options.from.toLowerCase();
      emails = emails.filter((e) =>
        e.from.toLowerCase().includes(fromFilter)
      );
    }

    if (options.json) {
      console.log(JSON.stringify(emails, null, 2));
      return;
    }

    if (emails.length === 0) {
      console.log("No emails found.");
      return;
    }

    // Print table format
    for (const email of emails) {
      console.log(`[${email.id}] ${email.date}`);
      console.log(`  From: ${email.from}`);
      console.log(`  Subject: ${email.subject}`);
      console.log();
    }
  } catch (error) {
    if (error instanceof Error) {
      console.error(`Error: ${error.message}`);
    } else {
      console.error("Error listing emails");
    }
    process.exit(1);
  }
}
