import { HandlerConfigSchema, evaluateCondition } from "./handle-utils.js";
import type { HandlerConfig } from "./handle-utils.js";

export { HandlerConfigSchema, evaluateCondition };
export type { HandlerConfig };

/**
 * Execute a registered hook handler for the given resource.
 *
 * TODO: Not yet implemented. Full implementation should:
 *   1. Read `workspace/hooks/<resourceId>/config.json`
 *   2. Validate the contents with {@link HandlerConfigSchema}
 *   3. Dispatch based on `handler_type` (e.g. "ai_response" triggers an agent
 *      session, "start_epoch" advances the epoch counter)
 *
 * @param _resourceId - The hook resource identifier used to locate the config.
 * @param _options    - Runtime options that override config values (e.g. model,
 *                      timeout) — exact shape TBD during implementation.
 */
export async function handleCommand(
  _resourceId: string,
  _options: Record<string, unknown>,
): Promise<void> {
  throw new Error("handleCommand is not yet implemented");
}
