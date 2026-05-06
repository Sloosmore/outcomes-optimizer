/**
 * Output formatting utilities for agent-instagram
 *
 * Supports both human-readable and JSON output modes.
 */

/**
 * Print output in either JSON or human-readable format
 */
export function printOutput(data: unknown, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(data, null, 2));
  } else if (typeof data === "string") {
    console.log(data);
  } else if (typeof data === "object" && data !== null) {
    printObject(data as Record<string, unknown>);
  } else {
    console.log(String(data));
  }
}

/**
 * Print an object as key-value pairs
 */
function printObject(obj: Record<string, unknown>, indent = 0): void {
  const prefix = " ".repeat(indent);
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined || value === null) continue;
    const label = formatLabel(key);
    if (typeof value === "object" && !Array.isArray(value)) {
      console.log(`${prefix}${label}:`);
      printObject(value as Record<string, unknown>, indent + 2);
    } else {
      console.log(`${prefix}${label}: ${value}`);
    }
  }
}

/**
 * Convert camelCase to Title Case label
 */
function formatLabel(key: string): string {
  return key
    .replace(/([A-Z])/g, " $1")
    .replace(/^./, (s) => s.toUpperCase())
    .trim();
}

/**
 * Print an error message and exit
 */
export function exitWithError(message: string, code = 1): never {
  console.error(`Error: ${message}`);
  process.exit(code);
}
