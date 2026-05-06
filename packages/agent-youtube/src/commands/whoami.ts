/**
 * whoami command - show authenticated channel
 */

import { adapterRegistry } from "../adapters/index.js";
import { EXIT_CODES } from "../config.js";

interface WhoamiOptions {
  json?: boolean;
}

export async function whoamiCommand(options: WhoamiOptions): Promise<void> {
  const adapter = adapterRegistry.get("youtube");

  if (!adapter.hasCredentials()) {
    console.error("Not authenticated. Run: agent-youtube auth");
    process.exit(EXIT_CODES.AUTH_REQUIRED);
  }

  try {
    const session = await adapter.restoreSession();
    const channel = session.channel;

    if (options.json) {
      console.log(JSON.stringify(channel, null, 2));
    } else {
      console.log(`Channel: ${channel.name}`);
      console.log(`ID: ${channel.id}`);
      if (channel.customUrl) {
        console.log(`URL: https://youtube.com/${channel.customUrl}`);
      }
    }
  } catch (error) {
    if (error instanceof Error) {
      console.error(`Failed: ${error.message}`);
    } else {
      console.error("Failed to get channel info");
    }
    process.exit(EXIT_CODES.API_ERROR);
  }
}
