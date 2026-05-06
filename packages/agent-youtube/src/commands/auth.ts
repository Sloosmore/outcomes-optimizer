/**
 * auth command - authenticate with YouTube
 */

import { adapterRegistry } from "../adapters/index.js";
import { EXIT_CODES } from "../config.js";

interface AuthOptions {
  status?: boolean;
}

export async function authCommand(options: AuthOptions): Promise<void> {
  const adapter = adapterRegistry.get("youtube");

  if (options.status) {
    // Check authentication status
    if (adapter.hasCredentials()) {
      try {
        const session = await adapter.restoreSession();
        console.log(`Authenticated as: ${session.channel.name}`);
        console.log(`Channel ID: ${session.channel.id}`);
        if (session.channel.customUrl) {
          console.log(`URL: https://youtube.com/${session.channel.customUrl}`);
        }
      } catch {
        console.error("Credentials exist but may be invalid.");
        console.error("Run: agent-youtube auth");
        process.exit(EXIT_CODES.AUTH_REQUIRED);
      }
    } else {
      console.log("Not authenticated.");
      console.log("Run: agent-youtube auth");
      process.exit(EXIT_CODES.AUTH_REQUIRED);
    }
    return;
  }

  // Run authentication flow
  try {
    console.log("Starting YouTube authentication...");
    const session = await adapter.authenticate();
    console.log(`\nAuthenticated successfully!`);
    console.log(`Channel: ${session.channel.name}`);
    console.log(`Channel ID: ${session.channel.id}`);
  } catch (error) {
    if (error instanceof Error) {
      console.error(`Authentication failed: ${error.message}`);
    } else {
      console.error("Authentication failed");
    }
    process.exit(EXIT_CODES.AUTH_REQUIRED);
  }
}
