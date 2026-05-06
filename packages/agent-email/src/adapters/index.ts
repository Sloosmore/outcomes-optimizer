export * from "./types.js";
export { OneSecMailAdapter, DOMAINS } from "./onesecmail.js";
export { MailTmAdapter } from "./mailtm.js";
export { GmailAdapter } from "./gmail.js";
export { SupabaseMailAdapter } from "./supabase-mail.js";
export { adapterRegistry } from "./registry.js";
export type { AdapterInfo } from "./registry.js";

// Register built-in adapters
import { adapterRegistry } from "./registry.js";
import { OneSecMailAdapter } from "./onesecmail.js";
import { MailTmAdapter } from "./mailtm.js";
import { GmailAdapter } from "./gmail.js";
import { SupabaseMailAdapter } from "./supabase-mail.js";

/**
 * Register Gmail adapter (default)
 *
 * Real Gmail account via OAuth2. Requires pre-configured credentials.
 * Bypasses disposable email blockers that many services use.
 */
adapterRegistry.register("gmail", {
  adapter: new GmailAdapter(),
  description: "Gmail via OAuth2 (real email, bypasses disposable blockers)",
  requiresAuth: true,
  ciCompatible: true,
});

/**
 * Register mail.tm adapter
 *
 * Private disposable email with authentication.
 * Works in cloud/CI environments.
 */
adapterRegistry.register("mailtm", {
  adapter: new MailTmAdapter(),
  description: "mail.tm - private disposable email (authenticated)",
  requiresAuth: true,
  ciCompatible: true,
});

/**
 * Register 1secmail adapter
 *
 * Public disposable email service. No auth required.
 * May be blocked in cloud/CI environments.
 */
adapterRegistry.register("1secmail", {
  adapter: new OneSecMailAdapter(),
  description: "1secmail.com - public disposable email (no auth)",
  requiresAuth: false,
  ciCompatible: false,
});

/**
 * Register Supabase adapter
 *
 * Supabase-backed relay. Supports both send and receive.
 * Ideal for agent-to-agent communication in headless/CI environments.
 */
adapterRegistry.register("supabase", {
  adapter: new SupabaseMailAdapter(),
  description: "Supabase-backed relay (supports send+receive, no external credentials needed)",
  requiresAuth: false,
  ciCompatible: true,
});
