import { adapterRegistry } from "../adapters/index.js";
import type { EmailSession } from "../adapters/index.js";
import type { InboxState } from "../state/inbox.js";

export { initCommand } from "./init.js";
export { addressCommand } from "./address.js";
export { listCommand } from "./list.js";
export { readCommand } from "./read.js";
export { countCommand } from "./count.js";
export { waitCommand } from "./wait.js";
export { extractLinkCommand, extractCodeCommand } from "./extract.js";
export { sendCommand } from "./send.js";

/**
 * Restore a session from saved inbox state
 *
 * Uses the adapter registry to get the correct adapter,
 * then restores the session with saved credentials.
 */
export function getSession(state: InboxState): EmailSession {
  const adapterName = state.adapter || adapterRegistry.getDefault();
  const adapter = adapterRegistry.get(adapterName);
  return adapter.restoreSession(state.credentials);
}
