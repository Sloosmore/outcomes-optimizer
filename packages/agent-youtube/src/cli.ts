/**
 * CLI entry point for agent-youtube
 */

import { Command } from "commander";
import { authCommand } from "./commands/auth.js";
import { uploadCommand } from "./commands/upload.js";
import { deleteCommand } from "./commands/delete.js";
import { metricsCommand } from "./commands/metrics.js";
import { listCommand } from "./commands/list.js";
import { quotaCommand } from "./commands/quota.js";
import { whoamiCommand } from "./commands/whoami.js";
import { transcriptCommand } from "./commands/transcript.js";

const program = new Command();

program
  .name("agent-youtube")
  .description("CLI for YouTube Shorts automation. In headless/automated mode, authentication is handled by the credential proxy sidecar — run 'agent-youtube whoami' to verify the session. 'agent-youtube auth' is for local interactive OAuth only.")
  .version("0.1.0");

// auth command
program
  .command("auth")
  .description("Authenticate with YouTube (local interactive OAuth only — not for headless/automated use; use 'agent-youtube whoami' to check session in automated mode)")
  .option("--status", "Check authentication status")
  .action(authCommand);

// upload command
program
  .command("upload <file>")
  .description("Upload a video as a YouTube Short")
  .requiredOption("--title <title>", "Video title (will append #Shorts if missing)")
  .option("--description <text>", "Video description")
  .option("--tags <tags>", "Comma-separated tags")
  .option(
    "--privacy <level>",
    "Privacy level: public, unlisted, private",
    "public"
  )
  .option("--json", "Output as JSON")
  .action(uploadCommand);

// delete command
program
  .command("delete <videoId>")
  .description("Delete a video")
  .option("--json", "Output as JSON")
  .action(deleteCommand);

// metrics command
program
  .command("metrics <videoId>")
  .description("Get metrics for a video")
  .option("--json", "Output as JSON")
  .action(metricsCommand);

// list command
program
  .command("list")
  .description("List recent uploads")
  .option("--limit <n>", "Maximum number of videos", parseInt)
  .option("--since <duration>", "Filter by time (e.g., 24h, 7d)")
  .option("--json", "Output as JSON")
  .action(listCommand);

// quota command
program
  .command("quota")
  .description("Check remaining daily quota")
  .option("--json", "Output as JSON")
  .action(quotaCommand);

// whoami command
program
  .command("whoami")
  .description("Show authenticated channel")
  .option("--json", "Output as JSON")
  .action(whoamiCommand);

// transcript command
program
  .command("transcript <url>")
  .description("Extract transcript from a YouTube video (no API quota)")
  .option("--lang <code>", "Language code", "en")
  .option("--json", "Output as JSON")
  .action(transcriptCommand);

program.parse();
