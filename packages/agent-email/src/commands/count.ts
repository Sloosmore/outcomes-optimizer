import { loadState } from "../state/inbox.js";
import { getSession } from "./index.js";

/**
 * Count emails in the current inbox
 */
export async function countCommand(): Promise<void> {
  const state = await loadState();

  if (!state) {
    console.error("Error: No inbox initialized. Run 'throwmail init' first.");
    process.exit(1);
  }

  const session = getSession(state);

  try {
    const emails = await session.list();
    console.log(emails.length);
  } catch (error) {
    if (error instanceof Error) {
      console.error(`Error: ${error.message}`);
    } else {
      console.error("Error counting emails");
    }
    process.exit(1);
  }
}
