import { loadState, markSeen } from "../state/inbox.js";
import { getLatestEmail } from "../utils/poll.js";
import { getSession } from "./index.js";

export interface ReadCommandOptions {
  text?: boolean;
  html?: boolean;
  json?: boolean;
}

/**
 * Read a specific email or the latest one
 */
export async function readCommand(
  idOrLatest: string,
  options: ReadCommandOptions
): Promise<void> {
  const state = await loadState();

  if (!state) {
    console.error("Error: No inbox initialized. Run 'throwmail init' first.");
    process.exit(1);
  }

  const session = getSession(state);

  try {
    let emailId: string;

    if (idOrLatest === "latest") {
      // Get the latest email
      const emails = await session.list();
      const latest = getLatestEmail(emails);

      if (!latest) {
        console.error("Error: No emails in inbox.");
        process.exit(1);
      }

      emailId = latest.id;
    } else {
      emailId = idOrLatest;
    }

    const email = await session.read(emailId);

    // Mark as seen
    await markSeen([emailId]);

    if (options.json) {
      console.log(JSON.stringify(email, null, 2));
      return;
    }

    // Print headers
    console.log(`From: ${email.from}`);
    console.log(`Subject: ${email.subject}`);
    console.log(`Date: ${email.date}`);
    console.log(`ID: ${email.id}`);
    console.log();

    // Print body based on flags
    if (options.html && !options.text) {
      console.log("--- HTML Body ---");
      console.log(email.htmlBody || "(no HTML body)");
    } else if (options.text || !options.html) {
      console.log("--- Text Body ---");
      console.log(email.textBody || "(no text body)");
    }

    // Show attachments if any
    if (email.attachments.length > 0) {
      console.log();
      console.log("--- Attachments ---");
      for (const att of email.attachments) {
        console.log(`  ${att.filename} (${att.contentType}, ${att.size} bytes)`);
      }
    }
  } catch (error) {
    if (error instanceof Error) {
      console.error(`Error: ${error.message}`);
    } else {
      console.error("Error reading email");
    }
    process.exit(1);
  }
}
