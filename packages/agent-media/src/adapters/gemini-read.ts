/**
 * Gemini read adapter — AI-powered media understanding and virality review
 *
 * Uses Google's Gemini models to:
 *   - Describe media content (plain text, no --review)
 *   - Review media for viral potential (natural language assessment, --review)
 *
 * The review approach is deliberately free-form: the model evaluates what
 * actually matters for virality on the target platform, rather than being
 * forced into a fixed set of criteria. The only structured fields extracted
 * are the decision signals an agent needs: verdict, confidence, overall score,
 * and actionable improvements.
 *
 * Video routing:
 *   < 20 MB  → inline base64
 *   ≥ 20 MB  → Files API (48-hour TTL)
 *
 * Images always use inline base64.
 * Audio read is stubbed — audio is analyzed as part of video review.
 */

import { readFile } from "fs/promises";
import path from "path";
import type {
  ReadAdapter,
  ReadOptions,
  ReadResult,
  ReviewCriteria,
  ReviewResult,
  MediaType,
} from "./read-types.js";
import { getProxyFetch, safeJsonParse } from "../utils/fetch.js";
import { isInterceptorActive } from "../utils/auth.js";
import { IMAGE_TIMEOUT_MS, VIDEO_TIMEOUT_MS } from "../config.js";

const REVIEW_MODEL = process.env.GEMINI_REVIEW_MODEL || "gemini-2.0-flash";

const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";
const FILES_UPLOAD_BASE = "https://generativelanguage.googleapis.com/upload/v1beta";

const LARGE_FILE_THRESHOLD = 20 * 1024 * 1024; // 20 MB

// Minimal structured schema — only the decision signals the agent needs.
// The substantive critique lives in the free-form `assessment` field.
const REVIEW_RESULT_SCHEMA = {
  type: "object",
  properties: {
    overall: { type: "number" },
    verdict: { type: "string", enum: ["post", "edit", "regenerate"] },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    assessment: { type: "string" },
    improvements: {
      type: "array",
      items: { type: "string" },
      maxItems: 3,
    },
  },
  required: ["overall", "verdict", "confidence", "assessment", "improvements"],
};

const PLATFORM_CONTEXT: Record<string, string> = {
  "youtube-shorts": `YouTube Shorts. Retention reality:
  - 90%+ of viewers decide to scroll past within the first 2 seconds
  - Average watch-through on a good Shorts is 60-70%; below 50% the algorithm buries it
  - The algorithm measures: average view duration, replays, shares, and comments
  - First frame IS the thumbnail — if it looks like nothing, it gets nothing
  - Sound is on by default; audio hook matters as much as the visual`,

  "instagram-reels": `Instagram Reels. Retention reality:
  - Sound is OFF by default — if the first frame doesn't tell a story without audio, you've lost most viewers before they unmute
  - 90%+ scroll past in the first 2 seconds; if the opening frame isn't a pattern interrupt, it's invisible
  - The algorithm weights saves and shares far more than likes — content needs a reason to be bookmarked
  - Watch-through rate below 50% means the algorithm won't push it to non-followers`,

  "general": `short-form social media. Retention reality:
  - 90%+ of viewers decide whether to keep watching within the first 2 seconds
  - There is no "warm up" — the hook must land on the very first frame
  - Average content gets less than 30% watch-through; viral content gets 70%+
  - Shares and saves signal value to the algorithm — likes are nearly meaningless`,
};

function buildReviewPrompt(mediaType: MediaType, criteria?: ReviewCriteria): string {
  const platformKey = criteria?.platform ?? "general";
  const platformContext = PLATFORM_CONTEXT[platformKey];

  const brief = criteria?.focus
    ? `Creator's brief: ${criteria.focus}`
    : "No brief provided. Evaluate purely for maximum virality and algorithmic reach.";

  const subject = mediaType === "image" ? "image" : "short-form video";

  return `You are a data-driven viral content strategist who thinks in retention curves, not vibes.

You are evaluating a ${subject} for ${platformContext}

${brief}

Be ruthless. Most content fails because creators confuse "good quality" with "will perform." They are not the same thing.

Your job is to predict real-world performance. Specifically:
- Will this survive the first 2-second scroll test? Most won't. Say so if it won't.
- What does the retention curve look like? Where do people drop off and why?
- Does this have a reason to be shared or saved, or is it just consumable and forgettable?
- Would YOU rewatch this? Would you send it to someone?

Don't soften the feedback. If this video would get buried by the algorithm, say that directly and explain exactly why. Vague encouragement kills careers.

"edit" = the bones are good but specific fixable things are killing performance.
"regenerate" = the concept or execution is fundamentally broken; no amount of trimming saves it.
Respond ONLY with the JSON review object.`;
}

function buildDescriptionPrompt(mediaType: MediaType): string {
  if (mediaType === "video") {
    return "Describe what is happening in this video. Include: content, pacing, visual style, audio (if any), and any text or captions. Be concise but thorough.";
  }
  if (mediaType === "image") {
    return "Describe what you see in this image. Include: subject, composition, colors, style, any text, and overall mood. Be concise but thorough.";
  }
  return "Describe the content of this media file.";
}

function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const mimeTypes: Record<string, string> = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mov": "video/quicktime",
    ".avi": "video/avi",
    ".mkv": "video/x-matroska",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".ogg": "audio/ogg",
    ".m4a": "audio/mp4",
  };
  return mimeTypes[ext] || "application/octet-stream";
}

/**
 * Read the Google API key from environment variables (standalone fallback).
 */
function readGoogleApiKey(): string {
  const key = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;
  if (!key) {
    throw new Error("GOOGLE_API_KEY or GEMINI_API_KEY environment variable not set");
  }
  return key;
}

/**
 * Build a Gemini API URL with auth, and return headers with X-Resource
 * or query-param auth depending on interceptor presence.
 */
function geminiAuth(basePath: string, extraHeaders?: Record<string, string>): { url: string; headers: Record<string, string> } {
  const headers: Record<string, string> = { ...extraHeaders };

  if (isInterceptorActive()) {
    headers["X-Resource"] = "google-api-key";
    return { url: basePath, headers };
  }

  const apiKey = readGoogleApiKey();
  const separator = basePath.includes("?") ? "&" : "?";
  return { url: `${basePath}${separator}key=${apiKey}`, headers };
}

export class GeminiReadAdapter implements ReadAdapter {
  readonly name = "gemini";

  private proxyFetch = getProxyFetch(VIDEO_TIMEOUT_MS);
  private imageFetch = getProxyFetch(IMAGE_TIMEOUT_MS);

  async readVideo(filePath: string, options?: ReadOptions): Promise<ReadResult> {
    const fileBuffer = await readFile(filePath);
    const mimeType = getMimeType(filePath);

    let videoPart: object;
    if (fileBuffer.length < LARGE_FILE_THRESHOLD) {
      videoPart = { inline_data: { mime_type: mimeType, data: fileBuffer.toString("base64") } };
    } else {
      const fileUri = await this.uploadToFilesApi(fileBuffer, mimeType, filePath);
      videoPart = { file_data: { file_uri: fileUri, mime_type: mimeType } };
    }

    if (options?.review) {
      const review = await this.generateReview([videoPart], "video", options.criteria);
      return { filePath, mediaType: "video", review };
    }
    const description = await this.generateDescription([videoPart], "video");
    return { filePath, mediaType: "video", description };
  }

  async readImage(filePath: string, options?: ReadOptions): Promise<ReadResult> {
    const fileBuffer = await readFile(filePath);
    const mimeType = getMimeType(filePath);

    const imagePart = {
      inline_data: { mime_type: mimeType, data: fileBuffer.toString("base64") },
    };

    if (options?.review) {
      const review = await this.generateReview([imagePart], "image", options.criteria);
      return { filePath, mediaType: "image", review };
    }
    const description = await this.generateDescription([imagePart], "image");
    return { filePath, mediaType: "image", description };
  }

  async readAudio(_filePath: string, _options?: ReadOptions): Promise<ReadResult> {
    throw new Error(
      "Audio read not yet implemented. Video review analyzes the audio track — use readVideo for video files with audio."
    );
  }

  /**
   * Upload a file to the Gemini Files API (for files >= 20 MB).
   * Uploaded files are available for 48 hours.
   */
  private async uploadToFilesApi(
    fileBuffer: Buffer,
    mimeType: string,
    filePath: string
  ): Promise<string> {
    const displayName = path.basename(filePath);
    const boundary = "gemini_upload_boundary_" + Date.now();
    const metadata = JSON.stringify({ file: { display_name: displayName } });

    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=utf-8\r\n\r\n${metadata}\r\n`, "utf-8"),
      Buffer.from(`--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`, "utf-8"),
      fileBuffer,
      Buffer.from(`\r\n--${boundary}--`, "utf-8"),
    ]);

    const { url, headers } = geminiAuth(`${FILES_UPLOAD_BASE}/files`, {
      "Content-Type": `multipart/related; boundary=${boundary}`,
      "X-Goog-Upload-Protocol": "multipart",
    });

    const response = await this.proxyFetch(url, {
      method: "POST",
      headers,
      body,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Files API upload failed (${response.status}): ${errorText.slice(0, 300)}`);
    }

    const data = await safeJsonParse<{ file: { uri: string } }>(response);
    return data.file.uri;
  }

  /**
   * Generate a free-form virality review of the given media parts.
   * The model evaluates what actually matters — no fixed criteria imposed.
   */
  private async generateReview(
    mediaParts: object[],
    mediaType: MediaType,
    criteria?: ReviewCriteria
  ): Promise<ReviewResult> {
    const { url, headers } = geminiAuth(
      `${GEMINI_API_BASE}/models/${REVIEW_MODEL}:generateContent`,
      { "Content-Type": "application/json" }
    );

    const response = await this.proxyFetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        contents: [{
          parts: [...mediaParts, { text: buildReviewPrompt(mediaType, criteria) }],
        }],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: REVIEW_RESULT_SCHEMA,
        },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Gemini review failed (${response.status}): ${errorText.slice(0, 300)}`);
    }

    const data = await safeJsonParse<{
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    }>(response);

    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error("No review content returned from Gemini");

    let parsed: ReviewResult;
    try {
      parsed = JSON.parse(text) as ReviewResult;
    } catch {
      throw new Error(`Failed to parse review JSON: ${text.slice(0, 200)}`);
    }
    // Clamp overall to 1-10 (Gemini's responseSchema doesn't support minimum/maximum)
    parsed.overall = Math.max(1, Math.min(10, parsed.overall));
    return parsed;
  }

  /**
   * Generate a plain text description of the given media parts.
   */
  private async generateDescription(
    mediaParts: object[],
    mediaType: MediaType
  ): Promise<string> {
    const { url, headers } = geminiAuth(
      `${GEMINI_API_BASE}/models/${REVIEW_MODEL}:generateContent`,
      { "Content-Type": "application/json" }
    );

    const fetchFn = mediaType === "image" ? this.imageFetch : this.proxyFetch;
    const response = await fetchFn(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        contents: [{
          parts: [...mediaParts, { text: buildDescriptionPrompt(mediaType) }],
        }],
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Gemini description failed (${response.status}): ${errorText.slice(0, 300)}`);
    }

    const data = await safeJsonParse<{
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    }>(response);

    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error("No description returned from Gemini");
    return text.trim();
  }
}
