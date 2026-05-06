export * from "./types.js";
export { InstagramApiAdapter } from "./instagram-api.js";
export { InstagrapiAdapter, InstagrapiSession } from "./instagrapi/adapter.js";
export { adapterRegistry } from "./registry.js";
export type { AdapterInfo } from "./registry.js";

// Register built-in adapters
import { adapterRegistry } from "./registry.js";
import { InstagramApiAdapter } from "./instagram-api.js";
import { InstagrapiAdapter } from "./instagrapi/adapter.js";

/**
 * Register Instagram Graph API adapter (default)
 *
 * Uses Meta Business Suite / Instagram Graph API.
 * Requires access token and business account ID.
 */
adapterRegistry.register("instagram-api", {
  adapter: new InstagramApiAdapter(),
  description: "Instagram Graph API (Meta Business Suite)",
  requiresAuth: true,
  ciCompatible: false,
});

/**
 * Register instagrapi adapter
 *
 * Uses the instagrapi Python library for profile write operations
 * (set bio, name, website, profile picture). Read operations use
 * the Instagram Graph API. Requires username + password via env vars.
 */
adapterRegistry.register("instagrapi", {
  adapter: new InstagrapiAdapter(),
  description: "instagrapi (profile write operations via Python)",
  requiresAuth: true,
  ciCompatible: false,
});
