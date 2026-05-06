import type { SessionState } from "../adapters/types.js";
import { InstagrapiSession } from "../adapters/instagrapi/adapter.js";
import { printOutput, exitWithError } from "../utils/output.js";

/**
 * Build an InstagrapiSession from environment variables for the given account.
 *
 * Reads:
 *   INSTAGRAM_<ACCOUNT>_PASSWORD
 *   INSTAGRAM_<ACCOUNT>_ACCESS_TOKEN
 *   INSTAGRAM_<ACCOUNT>_USER_ID
 *
 * Password is held only in memory — never written to disk.
 */
function buildSession(account: string): InstagrapiSession {
  const key = account.toUpperCase().replace(/-/g, "_");
  const username = account.toLowerCase();

  const password = process.env[`INSTAGRAM_${key}_PASSWORD`];
  const accessToken = process.env[`INSTAGRAM_${key}_ACCESS_TOKEN`];
  const userId = process.env[`INSTAGRAM_${key}_USER_ID`];

  if (!password) exitWithError(`Missing env var: INSTAGRAM_${key}_PASSWORD`);
  if (!accessToken) exitWithError(`Missing env var: INSTAGRAM_${key}_ACCESS_TOKEN`);
  if (!userId) exitWithError(`Missing env var: INSTAGRAM_${key}_USER_ID`);

  const state: SessionState = {
    accessToken: accessToken!,
    businessAccountId: userId!,
    username,
    created: new Date().toISOString(),
    adapter: "instagrapi",
  };

  return new InstagrapiSession(state, password!);
}

// ── set-bio ────────────────────────────────────────────────────────────────

export interface SetBioOptions {
  bio: string;
  account: string;
  json?: boolean;
}

export async function setProfileBioCommand(options: SetBioOptions): Promise<void> {
  const session = buildSession(options.account);

  await session.setProfileBio(options.bio).catch((err: Error) => {
    exitWithError(`Failed to set bio: ${err.message}`);
  });

  const profile = await session.getProfile().catch((err: Error) => {
    exitWithError(`Bio was set but read-back failed: ${err.message}`);
    return null;
  });

  if (!profile) return;

  if (profile.biography !== options.bio) {
    exitWithError(
      `Bio mismatch — expected: "${options.bio}", got: "${profile.biography}"`
    );
  }

  if (options.json) {
    printOutput({ success: true, biography: profile.biography }, true);
  } else {
    console.log(`Bio set: ${profile.biography}`);
  }
}

// ── set-name ───────────────────────────────────────────────────────────────

export interface SetNameOptions {
  name: string;
  account: string;
  json?: boolean;
}

export async function setProfileNameCommand(options: SetNameOptions): Promise<void> {
  const session = buildSession(options.account);

  await session.setProfileName(options.name).catch((err: Error) => {
    exitWithError(`Failed to set name: ${err.message}`);
  });

  const profile = await session.getProfile().catch((err: Error) => {
    exitWithError(`Name was set but read-back failed: ${err.message}`);
    return null;
  });

  if (!profile) return;

  if (profile.name !== options.name) {
    exitWithError(
      `Name mismatch — expected: "${options.name}", got: "${profile.name}"`
    );
  }

  if (options.json) {
    printOutput({ success: true, name: profile.name }, true);
  } else {
    console.log(`Name set: ${profile.name}`);
  }
}

// ── set-website ────────────────────────────────────────────────────────────

export interface SetWebsiteOptions {
  url: string;
  account: string;
  json?: boolean;
}

export async function setProfileWebsiteCommand(
  options: SetWebsiteOptions
): Promise<void> {
  const session = buildSession(options.account);

  await session.setProfileWebsite(options.url).catch((err: Error) => {
    exitWithError(`Failed to set website: ${err.message}`);
  });

  const profile = await session.getProfile().catch((err: Error) => {
    exitWithError(`Website was set but read-back failed: ${err.message}`);
    return null;
  });

  if (!profile) return;

  if (profile.website !== options.url) {
    exitWithError(
      `Website mismatch — expected: "${options.url}", got: "${profile.website}"`
    );
  }

  if (options.json) {
    printOutput({ success: true, website: profile.website }, true);
  } else {
    console.log(`Website set: ${profile.website}`);
  }
}

// ── set-pic ────────────────────────────────────────────────────────────────

export interface SetPicOptions {
  image: string;
  account: string;
  json?: boolean;
}

export async function setProfilePicCommand(options: SetPicOptions): Promise<void> {
  const session = buildSession(options.account);

  // Capture profile picture URL before the update
  const before = await session.getProfile().catch((err: Error) => {
    exitWithError(`Failed to fetch profile before update: ${err.message}`);
    return null;
  });

  if (!before) return;

  const previousUrl = before.profilePictureUrl;

  await session.setProfilePicture(options.image).catch((err: Error) => {
    exitWithError(`Failed to set profile picture: ${err.message}`);
  });

  const profile = await session.getProfile().catch((err: Error) => {
    exitWithError(`Picture was set but read-back failed: ${err.message}`);
    return null;
  });

  if (!profile) return;

  if (profile.profilePictureUrl === previousUrl) {
    exitWithError(
      "Profile picture URL did not change after update — the upload may have failed silently"
    );
  }

  if (options.json) {
    printOutput(
      { success: true, profilePictureUrl: profile.profilePictureUrl },
      true
    );
  } else {
    console.log(`Profile picture updated: ${profile.profilePictureUrl}`);
  }
}
