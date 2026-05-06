#!/usr/bin/env node

import { Command } from "commander";
import {
  initCommand,
  addressCommand,
  listCommand,
  readCommand,
  countCommand,
  waitCommand,
  extractLinkCommand,
  extractCodeCommand,
  sendCommand,
} from "./commands/index.js";

const program = new Command();

program
  .name("throwmail")
  .description("CLI for managing email inboxes in agent workflows")
  .version("0.3.0");

// === Inbox Commands ===

program
  .command("init")
  .description("Initialize a new inbox for this session")
  .option("-n, --name <name>", "Specific inbox name (e.g., 'mytest')")
  .option("-d, --domain <domain>", "Email domain")
  .option("-a, --adapter <adapter>", "Email adapter (default: mailtm)")
  .action((options) => initCommand(options));

program
  .command("address")
  .description("Show the current inbox address")
  .action(() => addressCommand());

// === Reading Commands ===

program
  .command("list")
  .description("List emails in the inbox")
  .option("-f, --from <sender>", "Filter by sender (partial match)")
  .option("--json", "Output as JSON")
  .action((options) => listCommand(options));

program
  .command("read <id>")
  .description("Read an email by ID or 'latest'")
  .option("-t, --text", "Show text body only")
  .option("-H, --html", "Show HTML body only")
  .option("--json", "Output as JSON")
  .action((id, options) => readCommand(id, options));

program
  .command("count")
  .description("Count emails in the inbox")
  .action(() => countCommand());

// === Waiting Commands ===

program
  .command("wait")
  .description("Wait for a new email")
  .option("-T, --timeout <seconds>", "Timeout in seconds", "60")
  .option("-f, --from <sender>", "Wait for email from sender (partial match)")
  .option("-s, --subject <text>", "Wait for email with subject containing text")
  .option("--json", "Output as JSON")
  .action((options) => waitCommand(options));

// === Extraction Commands ===

program
  .command("extract-link [id]")
  .description("Extract links from an email (default: latest)")
  .option("-a, --all", "Show all links (default: first only)")
  .option("--json", "Output as JSON")
  .action((id, options) => extractLinkCommand(id, options));

program
  .command("extract-code [id]")
  .description("Extract verification code from an email (default: latest)")
  .option("-p, --pattern <regex>", "Custom regex pattern for code")
  .option("--json", "Output as JSON")
  .action((id, options) => extractCodeCommand(id, options));

// === Send Command ===

program
  .command("send <to> <subject> <body>")
  .description("Send a message to another throwmail address (supabase adapter only)")
  .option("-a, --adapter <adapter>", "Email adapter")
  .action((to, subject, body, options) => sendCommand(to, subject, body, options));

program.parse();
