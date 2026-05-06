#!/usr/bin/env node

import "dotenv/config";
import { Command } from "commander";
import { loginCommand } from "./commands/login.js";
import { postCommand } from "./commands/post.js";
import { statusCommand } from "./commands/status.js";
import { profileCommand } from "./commands/profile.js";
import { analyticsCommand } from "./commands/analytics.js";
import {
  setProfileBioCommand,
  setProfileNameCommand,
  setProfileWebsiteCommand,
  setProfilePicCommand,
} from "./commands/profile-set.js";

// Trigger adapter registration
import "./adapters/index.js";

const program = new Command();

program
  .name("agent-instagram")
  .description("CLI for posting photos, videos, and reels to Instagram")
  .version("0.1.0")
  .enablePositionalOptions();

// === Auth ===

program
  .command("login")
  .description("Authenticate with Instagram")
  .option("-a, --adapter <adapter>", "Instagram adapter (default: instagram-api)")
  .option("-t, --token <token>", "Access token")
  .option("--account-id <id>", "Business account ID")
  .option("--json", "Output as JSON")
  .action((options) => loginCommand(options));

// === Post ===

program
  .command("post <type>")
  .description("Post content to Instagram (photo, video, or reel)")
  .option("-i, --image <url>", "Image URL (for photo posts)")
  .option("-v, --video <url>", "Video URL (for video/reel posts)")
  .option("-c, --caption <text>", "Post caption")
  .option("--cover <url>", "Cover/thumbnail image URL (for video/reel)")
  .option("--share-to-feed", "Share reel to feed (default: true)")
  .option("--json", "Output as JSON")
  .action((type, options) => postCommand(type, options));

// === Status ===

program
  .command("status <post-id>")
  .description("Check post/upload status")
  .option("--json", "Output as JSON")
  .action((postId, options) => statusCommand(postId, options));

// === Profile ===

const profile = program
  .command("profile")
  .description("Show or update account profile information")
  .option("--json", "Output as JSON")
  .option("--account <name>", "Account name (reads INSTAGRAM_<NAME>_PASSWORD from env)")
  .action((options) => profileCommand(options));

profile
  .command("set-bio")
  .description("Set profile bio/description")
  .requiredOption("--bio <text>", "Bio text to set")
  .requiredOption("--account <name>", "Account name (reads INSTAGRAM_<NAME>_PASSWORD from env)")
  .option("--json", "Output as JSON")
  .action((options) => setProfileBioCommand(options));

profile
  .command("set-name")
  .description("Set profile display name")
  .requiredOption("--name <text>", "Display name to set")
  .requiredOption("--account <name>", "Account name (reads INSTAGRAM_<NAME>_PASSWORD from env)")
  .option("--json", "Output as JSON")
  .action((options) => setProfileNameCommand(options));

profile
  .command("set-website")
  .description("Set profile website URL")
  .requiredOption("--url <url>", "Website URL to set")
  .requiredOption("--account <name>", "Account name (reads INSTAGRAM_<NAME>_PASSWORD from env)")
  .option("--json", "Output as JSON")
  .action((options) => setProfileWebsiteCommand(options));

profile
  .command("set-pic")
  .description("Set profile picture")
  .requiredOption("--image <path>", "Path to image file")
  .requiredOption("--account <name>", "Account name (reads INSTAGRAM_<NAME>_PASSWORD from env)")
  .option("--json", "Output as JSON")
  .action((options) => setProfilePicCommand(options));

// === Analytics ===

program
  .command("analytics <post-id>")
  .description("Get analytics for a post (impressions, reach, video views, saves)")
  .option("--json", "Output as JSON")
  .action((postId, options) => analyticsCommand(postId, options));

program.parse();
