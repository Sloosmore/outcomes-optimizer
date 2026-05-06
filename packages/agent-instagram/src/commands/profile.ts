import { loadSession } from "../state/session.js";
import { getSession } from "./index.js";
import { printOutput, exitWithError } from "../utils/output.js";
import type { SessionState } from "../adapters/types.js";
import { InstagrapiSession } from "../adapters/instagrapi/adapter.js";

export interface ProfileCommandOptions {
  json?: boolean;
  /** When provided, use instagrapi credentials from env instead of session file */
  account?: string;
}

/**
 * Build an InstagrapiSession from env vars for a named account.
 * Used when --account flag is provided.
 */
function buildAccountSession(account: string): InstagrapiSession {
  const key = account.toUpperCase().replace(/-/g, "_");
  const username = account.toLowerCase();
  const password = process.env[`INSTAGRAM_${key}_PASSWORD`];
  const accessToken = process.env[`INSTAGRAM_${key}_ACCESS_TOKEN`] ?? "";
  const userId = process.env[`INSTAGRAM_${key}_USER_ID`] ?? "";
  if (!password) exitWithError(`Missing env var: INSTAGRAM_${key}_PASSWORD`);
  const state: SessionState = {
    accessToken,
    businessAccountId: userId,
    username,
    created: new Date().toISOString(),
    adapter: "instagrapi",
  };
  return new InstagrapiSession(state, password!);
}

/**
 * Get and display profile information
 */
export async function profileCommand(options: ProfileCommandOptions): Promise<void> {
  // When --account is given, use instagrapi to read profile (no session file needed)
  if (options.account) {
    const session = buildAccountSession(options.account);
    try {
      const profile = await session.getProfile();
      if (options.json) {
        printOutput(profile, true);
      } else {
        console.log(`@${profile.username}`);
        if (profile.name) console.log(`Name: ${profile.name}`);
        if (profile.biography) console.log(`Bio: ${profile.biography}`);
        console.log(`Followers: ${profile.followersCount}`);
        console.log(`Following: ${profile.followsCount}`);
        console.log(`Posts: ${profile.mediaCount}`);
        if (profile.website) console.log(`Website: ${profile.website}`);
      }
    } catch (error) {
      exitWithError(error instanceof Error ? error.message : "Failed to fetch profile");
    }
    return;
  }

  const state = await loadSession();

  if (!state) {
    exitWithError("No session found. Run 'agent-instagram login' first.");
    return;
  }

  const session = getSession(state);

  try {
    const profile = await session.getProfile();

    if (options.json) {
      printOutput(profile, true);
    } else {
      console.log(`@${profile.username}`);
      if (profile.name) {
        console.log(`Name: ${profile.name}`);
      }
      if (profile.biography) {
        console.log(`Bio: ${profile.biography}`);
      }
      console.log(`Followers: ${profile.followersCount}`);
      console.log(`Following: ${profile.followsCount}`);
      console.log(`Posts: ${profile.mediaCount}`);
      if (profile.website) {
        console.log(`Website: ${profile.website}`);
      }
    }
  } catch (error) {
    if (error instanceof Error) {
      exitWithError(error.message);
    }
    exitWithError("Failed to fetch profile");
  }
}
