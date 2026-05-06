import { loadState, markSeen } from "../state/inbox.js";
import { getLatestEmail } from "../utils/poll.js";
import { extractLinks, extractCode } from "../utils/extract.js";
import { getSession } from "./index.js";

export interface ExtractLinkOptions {
  all?: boolean;
  json?: boolean;
}

export interface ExtractCodeOptions {
  pattern?: string;
  json?: boolean;
}

/**
 * Helper to get email content by ID or latest
 */
async function getEmailContent(
  idOrLatest?: string
): Promise<{ textBody: string; htmlBody: string; id: string } | null> {
  const state = await loadState();

  if (!state) {
    console.error("Error: No inbox initialized. Run 'throwmail init' first.");
    process.exit(1);
  }

  const session = getSession(state);

  let emailId: string;

  if (!idOrLatest || idOrLatest === "latest") {
    const emails = await session.list();
    const latest = getLatestEmail(emails);

    if (!latest) {
      return null;
    }

    emailId = latest.id;
  } else {
    emailId = idOrLatest;
  }

  const email = await session.read(emailId);
  await markSeen([emailId]);

  return {
    textBody: email.textBody,
    htmlBody: email.htmlBody,
    id: email.id,
  };
}

/**
 * Extract links from an email
 */
export async function extractLinkCommand(
  emailId: string | undefined,
  options: ExtractLinkOptions
): Promise<void> {
  try {
    const content = await getEmailContent(emailId);

    if (!content) {
      console.error("Error: No emails in inbox.");
      process.exit(1);
    }

    const links = extractLinks(content.htmlBody, content.textBody);

    if (links.length === 0) {
      console.error("Error: No links found in email.");
      process.exit(1);
    }

    if (options.json) {
      console.log(JSON.stringify(options.all ? links : [links[0]], null, 2));
      return;
    }

    if (options.all) {
      for (const link of links) {
        console.log(link);
      }
    } else {
      console.log(links[0]);
    }
  } catch (error) {
    if (error instanceof Error) {
      console.error(`Error: ${error.message}`);
    } else {
      console.error("Error extracting links");
    }
    process.exit(1);
  }
}

/**
 * Extract verification code from an email
 */
export async function extractCodeCommand(
  emailId: string | undefined,
  options: ExtractCodeOptions
): Promise<void> {
  try {
    const content = await getEmailContent(emailId);

    if (!content) {
      console.error("Error: No emails in inbox.");
      process.exit(1);
    }

    // Search in text body primarily
    const code = extractCode(content.textBody, options.pattern);

    if (!code) {
      console.error("Error: No verification code found in email.");
      process.exit(1);
    }

    if (options.json) {
      console.log(JSON.stringify({ code }, null, 2));
      return;
    }

    console.log(code);
  } catch (error) {
    if (error instanceof Error) {
      console.error(`Error: ${error.message}`);
    } else {
      console.error("Error extracting code");
    }
    process.exit(1);
  }
}
