/**
 * Types for the read command — AI-powered media understanding and virality review
 */

export type MediaType = "video" | "image" | "audio";

export interface ReviewCriteria {
  /**
   * Natural language brief describing what the content is trying to achieve
   * and what to focus on during review.
   *
   * Example: "Make sure it has a snappy hook in the first 2 seconds that stops
   * the scroll, no dead air in the middle, and a clean loop back to the start."
   *
   * When omitted, the reviewer focuses on general virality and engagement potential.
   */
  focus?: string;
  /** Platform context — shapes what "good" means for this content */
  platform?: "youtube-shorts" | "instagram-reels" | "general";
}

export interface ReviewResult {
  /** Overall quality/virality score 1–10 */
  overall: number;
  /** Decision: ready to post, needs editing, or start over */
  verdict: "post" | "edit" | "regenerate";
  /** How confident the reviewer is in this verdict */
  confidence: "high" | "medium" | "low";
  /**
   * Free-form natural language critique. The model evaluates what actually
   * matters for this content — no fixed criteria imposed.
   */
  assessment: string;
  /**
   * Specific, actionable things to change. Only populated for "edit" and
   * "regenerate" verdicts. Max 3, ordered by impact.
   */
  improvements: string[];
}

export interface ReadResult {
  filePath: string;
  mediaType: MediaType;
  /** Plain description (non-review mode) */
  description?: string;
  /** Virality review (review mode) */
  review?: ReviewResult;
}

export interface ReadOptions {
  review?: boolean;
  criteria?: ReviewCriteria;
}

export interface ReadAdapter {
  name: string;
  readVideo(filePath: string, options?: ReadOptions): Promise<ReadResult>;
  readImage(filePath: string, options?: ReadOptions): Promise<ReadResult>;
  readAudio(filePath: string, options?: ReadOptions): Promise<ReadResult>;
}
