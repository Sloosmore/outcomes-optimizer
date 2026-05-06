import { MAX_REGEX_INPUT_LENGTH } from "../config.js";

/**
 * Extract URLs/links from email content
 */
export function extractLinks(html: string, text: string): string[] {
  // Limit input length to prevent performance issues with regex matching
  const safeHtml = html.length > MAX_REGEX_INPUT_LENGTH ? html.slice(0, MAX_REGEX_INPUT_LENGTH) : html;
  const safeText = text.length > MAX_REGEX_INPUT_LENGTH ? text.slice(0, MAX_REGEX_INPUT_LENGTH) : text;

  const links: Set<string> = new Set();

  // From HTML href attributes
  const hrefRegex = /href=["']([^"']+)["']/gi;
  let match;
  while ((match = hrefRegex.exec(safeHtml)) !== null) {
    const url = match[1];
    if (url.startsWith("http://") || url.startsWith("https://")) {
      links.add(url);
    }
  }

  // From plain text - match URLs
  const urlRegex = /https?:\/\/[^\s<>"')\]]+/gi;
  while ((match = urlRegex.exec(safeText)) !== null) {
    // Clean up trailing punctuation that might have been captured
    let url = match[0];
    url = url.replace(/[.,;:!?)]+$/, "");
    links.add(url);
  }

  // Also search HTML for plain text URLs (not in href)
  while ((match = urlRegex.exec(safeHtml)) !== null) {
    let url = match[0];
    url = url.replace(/[.,;:!?)]+$/, "");
    links.add(url);
  }

  return Array.from(links);
}

/**
 * Patterns for finding verification codes, ordered by specificity
 */
const CODE_PATTERNS = [
  // Explicit labels
  /verification\s*code[:\s]+(\d{4,8})/i,
  /your\s*code\s*(?:is)?[:\s]+(\d{4,8})/i,
  /code[:\s]+(\d{4,8})/i,
  /OTP[:\s]+(\d{4,8})/i,
  /pin[:\s]+(\d{4,8})/i,
  /passcode[:\s]+(\d{4,8})/i,
  // Standalone 6-digit (most common OTP length)
  /\b(\d{6})\b/,
  // Standalone 4-digit
  /\b(\d{4})\b/,
  // Standalone 8-digit
  /\b(\d{8})\b/,
];

/**
 * Extract verification code from email content
 *
 * @param text - Email text content
 * @param customPattern - Optional custom regex pattern (as string)
 * @returns The extracted code or null if not found
 * @throws Error if customPattern is invalid regex syntax
 */
export function extractCode(text: string, customPattern?: string): string | null {
  if (customPattern) {
    // Validate and compile regex with error handling
    let regex: RegExp;
    try {
      regex = new RegExp(customPattern);
    } catch (e) {
      throw new Error(`Invalid regex pattern: ${e instanceof Error ? e.message : "syntax error"}`);
    }

    // Limit text length to prevent ReDoS on pathological patterns
    const safeText = text.length > MAX_REGEX_INPUT_LENGTH ? text.slice(0, MAX_REGEX_INPUT_LENGTH) : text;
    const match = safeText.match(regex);
    return match ? (match[1] || match[0]) : null;
  }

  // Try patterns in order of specificity
  for (const pattern of CODE_PATTERNS) {
    const match = text.match(pattern);
    if (match && match[1]) {
      return match[1];
    }
  }

  return null;
}
