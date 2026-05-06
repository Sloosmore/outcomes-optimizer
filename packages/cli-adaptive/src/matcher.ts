import type { MatchResult } from './types.js';

/**
 * Converts a nested command tree (array of string arrays) to a flat list
 * of space-joined command strings.
 * e.g. [["resource", "link"], ["sandbox", "execute"]] → ["resource link", "sandbox execute"]
 */
export function flattenCommands(commands: string[][]): string[] {
  return commands.map((parts) => parts.join(' '));
}

/**
 * Compute the Levenshtein edit distance between two strings.
 * H6: Uses two 1D arrays instead of a full 2D matrix to reduce allocations.
 */
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  let prev = new Array<number>(n + 1);
  let curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      curr[j] = a[i - 1] === b[j - 1]
        ? prev[j - 1]!
        : 1 + Math.min(prev[j]!, curr[j - 1]!, prev[j - 1]!);
    }
    const tmp = prev; prev = curr; curr = tmp;
  }

  return prev[n]!;
}

/**
 * Structural matcher. Priority:
 * 1. Exact leaf match: input exactly equals the last word of any candidate → confidence 0.95
 *    H5: ambiguous leaf matches (multiple candidates share the same leaf) return null.
 * 2. Prefix match: input is a prefix of any candidate (space-separated) → confidence 0.8
 * 3. Levenshtein fallback: closest edit distance → confidence scaled by distance
 *    H6: best and second-best computed in a single pass.
 *    M2: low-confidence matches (distance too large relative to string length) return null.
 *
 * Structural match always wins over pure levenshtein.
 */
export function match(input: string, candidates: string[]): MatchResult | null {
  if (candidates.length === 0) return null;

  const trimmed = input.trim();
  if (!trimmed) return null;

  // 1. Exact leaf match (last word of candidate equals input)
  const leafMatches: string[] = [];
  for (const candidate of candidates) {
    const parts = candidate.split(' ');
    const leaf = parts[parts.length - 1];
    if (leaf === trimmed) {
      leafMatches.push(candidate);
    }
  }

  if (leafMatches.length === 1) {
    return { command: leafMatches[0]!, confidence: 0.95 };
  }

  if (leafMatches.length > 1) {
    // H5: Multiple exact leaf matches — ambiguous, don't suggest
    return null;
  }

  // 2. Prefix match: input is a space-separated prefix of any candidate
  const prefixMatches: string[] = [];
  for (const candidate of candidates) {
    if (candidate.startsWith(trimmed + ' ') || candidate === trimmed) {
      prefixMatches.push(candidate);
    }
  }

  if (prefixMatches.length > 0) {
    return { command: prefixMatches[0]!, confidence: 0.8 };
  }

  // 3. Levenshtein fallback against full candidates and their leaves
  // H6: Track best and second-best in a single pass (no duplicate O(C) scan)
  let bestCandidate: string | null = null;
  let bestDistance = Infinity;
  let secondBestDistance = Infinity;

  for (const candidate of candidates) {
    const parts = candidate.split(' ');
    const leaf = parts[parts.length - 1]!;
    const dist = Math.min(levenshtein(trimmed, candidate), levenshtein(trimmed, leaf));

    if (dist < bestDistance) {
      secondBestDistance = bestDistance;
      bestDistance = dist;
      bestCandidate = candidate;
    } else if (dist < secondBestDistance) {
      secondBestDistance = dist;
    }
  }

  if (bestCandidate === null) return null;

  // Ambiguity guard: if two candidates are nearly tied, return null
  if (secondBestDistance - bestDistance <= 1 && secondBestDistance < Infinity) {
    return null;
  }

  // M2: Reject very low-confidence matches (distance too high relative to string length)
  const maxLen = Math.max(trimmed.length, bestCandidate.length, 1);
  if (bestDistance > Math.max(2, Math.floor(maxLen * 0.4))) {
    return null;
  }

  // Scale confidence: closer distance → higher confidence
  const confidence = Math.max(0, 1 - bestDistance / maxLen) * 0.7;

  return { command: bestCandidate, confidence };
}
