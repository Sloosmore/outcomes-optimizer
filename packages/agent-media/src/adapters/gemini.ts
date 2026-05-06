/**
 * Gemini adapter for image generation
 *
 * Uses Google's Gemini 3 Pro Image Preview model for image generation
 * via the generateContent API.
 */

import type {
  MediaAdapter,
  AdapterCapabilities,
  PricingInfo,
  ImageOptions,
  GeneratedImage,
  CostEstimate,
} from "./types.js";
import type { Modality } from "../config.js";
import { getProxyFetch, safeJsonParse } from "../utils/fetch.js";
import { isInterceptorActive } from "../utils/auth.js";
import { IMAGE_TIMEOUT_MS, MODEL_LIMITS, ASPECT_RATIO_TOLERANCE } from "../config.js";

// Gemini image pricing (approximate, per image)
const GEMINI_IMAGE_PRICING: Record<string, number> = {
  "1:1": 0.03,
  "2:3": 0.04,
  "3:2": 0.04,
  "3:4": 0.04,
  "4:3": 0.04,
  "4:5": 0.04,
  "5:4": 0.04,
  "9:16": 0.045,
  "16:9": 0.045,
  "21:9": 0.05,
};

// Gemini API base URL
const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";

// Default model for image generation
const GEMINI_IMAGE_MODEL = "gemini-3-pro-image-preview";

export class GeminiImageAdapter implements MediaAdapter {
  readonly name = "gemini";

  readonly capabilities: AdapterCapabilities = {
    modalities: ["image"],
    image: {
      // Gemini 3 Pro Image supported aspect ratios
      supportedSizes: ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"],
      maxCount: 4,
    },
  };

  readonly pricing: PricingInfo = {
    image: { perImage: GEMINI_IMAGE_PRICING },
  };

  private proxyFetch = getProxyFetch(IMAGE_TIMEOUT_MS);

  async generateImage(
    prompt: string,
    options?: ImageOptions
  ): Promise<GeneratedImage[]> {
    const aspectRatio = normalizeAspectRatio(options?.size || "1:1");
    const count = options?.count || 1;

    // Validate aspect ratio
    if (!this.capabilities.image?.supportedSizes.includes(aspectRatio)) {
      throw new Error(
        `Invalid aspect ratio: ${aspectRatio}. Supported: ${this.capabilities.image?.supportedSizes.join(", ")}`
      );
    }

    // Validate prompt
    if (!prompt?.trim()) {
      throw new Error("Prompt cannot be empty");
    }

    // Validate count
    const maxCount = this.capabilities.image?.maxCount || 4;
    if (count < 1 || count > maxCount) {
      throw new Error(`Count must be between 1 and ${maxCount}, got ${count}`);
    }

    // Validate prompt length
    if (prompt.length > MODEL_LIMITS.GEMINI_MAX_PROMPT_LENGTH) {
      throw new Error(
        `Prompt length ${prompt.length} exceeds maximum ${MODEL_LIMITS.GEMINI_MAX_PROMPT_LENGTH} characters`
      );
    }

    // Build URL and headers based on interceptor presence
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    let url: string;

    if (isInterceptorActive()) {
      url = `${GEMINI_API_BASE}/models/${GEMINI_IMAGE_MODEL}:generateContent`;
      headers["X-Resource"] = "google-api-key";
    } else {
      const apiKey = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;
      if (!apiKey) {
        throw new Error("GOOGLE_API_KEY or GEMINI_API_KEY environment variable not set");
      }
      url = `${GEMINI_API_BASE}/models/${GEMINI_IMAGE_MODEL}:generateContent?key=${apiKey}`;
    }

    const results: GeneratedImage[] = [];
    const errors: string[] = [];
    const [width, height] = getDimensionsFromAspectRatio(aspectRatio);

    // Generate images one at a time (Gemini doesn't support batch in same call)
    // Continue on errors to preserve partial results
    for (let i = 0; i < count; i++) {
      try {
        const response = await this.proxyFetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify({
            contents: [
              {
                parts: [{ text: prompt }],
              },
            ],
            generationConfig: {
              responseModalities: ["TEXT", "IMAGE"],
              imageConfig: {
                aspectRatio: aspectRatio,
              },
            },
          }),
        });

        if (!response.ok) {
          const errorText = await response.text();
          errors.push(`Image ${i + 1}: API error ${response.status}: ${errorText.slice(0, 200)}`);
          continue;
        }

        const data = await safeJsonParse<{
          candidates?: Array<{
            content?: {
              parts?: Array<{
                inlineData?: {
                  mimeType?: string;
                  data?: string;
                };
                text?: string;
              }>;
            };
          }>;
        }>(response);

        // Extract image from response
        const parts = data.candidates?.[0]?.content?.parts;
        if (!parts) {
          errors.push(`Image ${i + 1}: No content in response`);
          continue;
        }

        let foundImage = false;
        for (const part of parts) {
          if (part.inlineData?.data) {
            results.push({
              data: Buffer.from(part.inlineData.data, "base64"),
              mimeType: part.inlineData.mimeType || "image/png",
              width,
              height,
            });
            foundImage = true;
            break;
          }
        }

        if (!foundImage) {
          errors.push(`Image ${i + 1}: No image data in response`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`Image ${i + 1}: ${message}`);
        continue;
      }
    }

    if (results.length === 0) {
      throw new Error(`All image generations failed: ${errors.join("; ")}`);
    }

    return results;
  }

  estimateCost(
    modality: Modality,
    options: Record<string, unknown>
  ): CostEstimate {
    if (modality !== "image") {
      return { min: 0, max: 0, currency: "USD", breakdown: "N/A" };
    }

    const sizeInput = typeof options.size === "string" ? options.size : "1:1";
    const aspectRatio = normalizeAspectRatio(sizeInput);
    const countInput = typeof options.count === "number" ? options.count : 1;
    const count = Math.max(1, Math.floor(countInput));

    const perImage = GEMINI_IMAGE_PRICING[aspectRatio] || GEMINI_IMAGE_PRICING["1:1"];
    const total = perImage * count;

    return {
      min: total,
      max: total,
      currency: "USD",
      breakdown: `${count} image${count > 1 ? "s" : ""} @ $${perImage.toFixed(3)} = $${total.toFixed(3)}`,
    };
  }
}

/**
 * Normalize size input to aspect ratio
 * Accepts both "1024x1024" format and "1:1" format
 */
export function normalizeAspectRatio(input: string): string {
  // If already in aspect ratio format, return as-is
  if (input.includes(":")) {
    return input;
  }

  // Convert pixel dimensions to aspect ratio
  const [width, height] = input.split("x").map(Number);
  if (!width || !height || isNaN(width) || isNaN(height)) {
    return "1:1"; // Silent fallback for invalid input
  }

  const ratio = width / height;
  if (Math.abs(ratio - 1) < ASPECT_RATIO_TOLERANCE) return "1:1";
  if (Math.abs(ratio - 16 / 9) < ASPECT_RATIO_TOLERANCE) return "16:9";
  if (Math.abs(ratio - 9 / 16) < ASPECT_RATIO_TOLERANCE) return "9:16";
  if (Math.abs(ratio - 4 / 3) < ASPECT_RATIO_TOLERANCE) return "4:3";
  if (Math.abs(ratio - 3 / 4) < ASPECT_RATIO_TOLERANCE) return "3:4";
  if (Math.abs(ratio - 3 / 2) < ASPECT_RATIO_TOLERANCE) return "3:2";
  if (Math.abs(ratio - 2 / 3) < ASPECT_RATIO_TOLERANCE) return "2:3";
  if (Math.abs(ratio - 5 / 4) < ASPECT_RATIO_TOLERANCE) return "5:4";
  if (Math.abs(ratio - 4 / 5) < ASPECT_RATIO_TOLERANCE) return "4:5";
  if (Math.abs(ratio - 21 / 9) < ASPECT_RATIO_TOLERANCE) return "21:9";

  // Default to closest common ratio
  if (ratio > 1) return "16:9";
  if (ratio < 1) return "9:16";
  return "1:1";
}

/**
 * Get pixel dimensions from aspect ratio (per Gemini 3 Pro Image docs)
 */
function getDimensionsFromAspectRatio(aspectRatio: string): [number, number] {
  switch (aspectRatio) {
    case "1:1":
      return [1024, 1024];
    case "16:9":
      return [1344, 768];
    case "9:16":
      return [768, 1344];
    case "4:3":
      return [1184, 864];
    case "3:4":
      return [864, 1184];
    case "2:3":
      return [832, 1248];
    case "3:2":
      return [1248, 832];
    case "4:5":
      return [896, 1152];
    case "5:4":
      return [1152, 896];
    case "21:9":
      return [1536, 672];
    default:
      return [1024, 1024];
  }
}
