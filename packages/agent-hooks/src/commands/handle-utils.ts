import { z } from "zod";

/**
 * Zod schema for validating a hook handler configuration object.
 * Used to parse and validate `config.json` files stored under
 * `workspace/hooks/<resource-id>/`.
 */
export const HandlerConfigSchema = z.object({
  handler_type: z.enum(["ai_response", "start_epoch"]),
  model: z.string().optional(),
  tools: z.array(z.string()).optional(),
  rate_limit_per_hour: z.number().optional(),
  max_budget_usd: z.number().optional(),
  timeout_seconds: z.number().optional(),
  condition: z.string().optional(),
  reason: z.string().optional(),
});

/** TypeScript type inferred from {@link HandlerConfigSchema}. */
export type HandlerConfig = z.infer<typeof HandlerConfigSchema>;

/**
 * Evaluate a condition string against a payload object.
 *
 * Condition format: "payload.some.path > 100" or "some.path == value"
 * Supports operators: >, >=, <, <=, ==, !=
 * For == and !=: compares as strings.
 * For numeric operators: parseFloat both sides, return false if either is NaN.
 */
export function evaluateCondition(
  payload: Record<string, unknown>,
  condition: string,
): boolean {
  // Parse the condition into: path, operator, value
  const match = condition.match(
    /^(.+?)\s*(>=|<=|!=|==|>|<)\s*(.+)$/,
  );
  if (!match) return false;

  let [, path, operator, conditionValue] = match;
  path = path.trim();
  conditionValue = conditionValue.trim();

  // Strip "payload." prefix if present
  if (path.startsWith("payload.")) {
    path = path.slice("payload.".length);
  }

  // Resolve the deep dot-notation path
  const DENIED_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);
  const segments = path.split(".");
  let current: unknown = payload;
  for (const segment of segments) {
    if (DENIED_SEGMENTS.has(segment)) return false;
    if (current === null || current === undefined) return false;
    if (typeof current !== "object") return false;
    current = (current as Record<string, unknown>)[segment];
  }

  // Missing path → false
  if (current === undefined || current === null) return false;

  if (operator === "==" || operator === "!=") {
    const resolvedStr = String(current);
    const condStr = String(conditionValue);
    if (operator === "==") return resolvedStr === condStr;
    return resolvedStr !== condStr;
  }

  // Numeric comparison
  const resolvedNum = parseFloat(String(current));
  const condNum = parseFloat(conditionValue);
  if (isNaN(resolvedNum) || isNaN(condNum)) return false;

  switch (operator) {
    case ">":
      return resolvedNum > condNum;
    case ">=":
      return resolvedNum >= condNum;
    case "<":
      return resolvedNum < condNum;
    case "<=":
      return resolvedNum <= condNum;
    default:
      return false;
  }
}
