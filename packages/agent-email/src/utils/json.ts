/**
 * Safe JSON parsing utilities for API responses
 */

import { MAX_RESPONSE_SIZE } from "../config.js";

/**
 * Safely parse JSON from a Response object with size limits
 * @throws Error with descriptive message on parse failure or size exceeded
 */
export async function safeJsonParse<T>(
  res: Response,
  context: string,
  maxSize: number = MAX_RESPONSE_SIZE
): Promise<T> {
  // Check Content-Length header if available
  const contentLength = res.headers.get("content-length");
  if (contentLength) {
    const size = parseInt(contentLength, 10);
    if (!isNaN(size) && size > maxSize) {
      throw new Error(`${context}: Response too large (${size} bytes, max ${maxSize})`);
    }
  }

  let text: string;
  try {
    text = await res.text();
  } catch {
    throw new Error(`${context}: Failed to read response body`);
  }

  // Check actual size (in case Content-Length was missing or wrong)
  if (text.length > maxSize) {
    throw new Error(`${context}: Response too large (${text.length} bytes, max ${maxSize})`);
  }

  try {
    return JSON.parse(text) as T;
  } catch {
    // Truncate response for error message
    const preview = text.length > 100 ? text.slice(0, 100) + "..." : text;
    throw new Error(`${context}: Invalid JSON response - ${preview}`);
  }
}

/**
 * Get a nested property safely, returning undefined if path doesn't exist
 */
export function getPath<T>(obj: unknown, path: string): T | undefined {
  const parts = path.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current as T | undefined;
}
