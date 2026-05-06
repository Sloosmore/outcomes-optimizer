import { loadState } from "../state/inbox.js";
import { getSession } from "./index.js";

export interface SendCommandOptions {
  adapter?: string;
}

/**
 * Send a message to another throwmail address.
 *
 * Only works with adapters that implement the optional send() method
 * (currently: supabase adapter only).
 */
export async function sendCommand(
  to: string,
  subject: string,
  body: string,
  _options: SendCommandOptions
): Promise<void> {
  const state = await loadState();

  if (!state) {
    console.error("Error: No inbox initialized. Run 'throwmail init' first.");
    process.exit(1);
  }

  const session = getSession(state);

  if (!session.send) {
    console.error(
      `Error: Adapter "${state.adapter}" does not support sending. ` +
        "Use the supabase adapter: throwmail init --adapter supabase"
    );
    process.exit(1);
  }

  try {
    await session.send(to, subject, body);
    console.log(`Sent to ${to}: ${subject}`);
  } catch (error) {
    if (error instanceof Error) {
      console.error(`Error: ${error.message}`);
    } else {
      console.error("Error sending message");
    }
    process.exit(1);
  }
}
