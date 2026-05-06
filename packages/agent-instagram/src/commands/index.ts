import { adapterRegistry } from "../adapters/index.js";
import type { InstagramSession, SessionState } from "../adapters/index.js";

export { loginCommand } from "./login.js";
export { postCommand } from "./post.js";
export { statusCommand } from "./status.js";
export { profileCommand } from "./profile.js";
export { analyticsCommand } from "./analytics.js";

/**
 * Restore a session from saved state
 *
 * Uses the adapter registry to get the correct adapter,
 * then restores the session with saved credentials.
 */
export function getSession(state: SessionState): InstagramSession {
  const adapterName = state.adapter || adapterRegistry.getDefault();
  const adapter = adapterRegistry.get(adapterName);
  return adapter.restoreSession(state);
}
