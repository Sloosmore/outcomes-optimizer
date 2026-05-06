/**
 * Google adapter for video generation
 *
 * Uses Google Veo API for video generation via direct REST calls
 * Video generation is async - start job, poll for completion
 */

import type {
  MediaAdapter,
  AdapterCapabilities,
  PricingInfo,
  VideoOptions,
  VideoJob,
  CostEstimate,
} from "./types.js";
import type { Modality } from "../config.js";
import { DEFAULT_VIDEO_DURATION_S, VIDEO_TIMEOUT_MS } from "../config.js";
import { getProxyFetch, safeJsonParse } from "../utils/fetch.js";
import { isInterceptorActive } from "../utils/auth.js";

// Veo 3.1 Fast pricing ($0.10/sec without audio, $0.15/sec with audio)
const VEO_PRICE_PER_SECOND = 0.10;

// Veo API base URL (Gemini API)
const VEO_API_BASE = "https://generativelanguage.googleapis.com/v1beta";

// Model ID - configurable, defaults to Veo 3.1 Fast for speed and cost
// Veo 3.1 Fast: "veo-3.1-fast-generate-preview" (~$0.10-0.15/sec)
// Veo 3.1: "veo-3.1-generate-preview" (~$0.40-0.75/sec)
// Veo 2.0: "veo-2.0-generate-001" (legacy)
const VEO_MODEL = process.env.VEO_MODEL || "veo-3.1-fast-generate-preview";

/**
 * Build headers for Google Veo API requests.
 * With interceptor: sets X-Resource header for proxy auth injection.
 * Without interceptor: sets x-goog-api-key header directly.
 */
function veoAuthHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };

  if (isInterceptorActive()) {
    headers["X-Resource"] = "google-api-key";
  } else {
    const apiKey = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error("GOOGLE_API_KEY or GEMINI_API_KEY environment variable not set");
    }
    headers["x-goog-api-key"] = apiKey;
  }

  return headers;
}

export class GoogleAdapter implements MediaAdapter {
  readonly name = "google";

  // Veo 3.1 generates an audio track (sound effects, ambient audio, dialogue)
  // alongside the video. To include character speech, use quoted dialogue in
  // the prompt: e.g. 'A character waves and says, "Hello!"'
  // Vague speech descriptions without quoted dialogue may trigger the audio
  // safety filter and result in no video being generated.
  readonly capabilities: AdapterCapabilities = {
    modalities: ["video"],
    video: {
      maxDurationSeconds: 8,
      supportedAspectRatios: ["16:9", "9:16", "1:1"],
      outputExpires: true,
      expirationHours: 48,
      generatesAudio: true,
    },
  };

  readonly pricing: PricingInfo = {
    video: { perSecond: VEO_PRICE_PER_SECOND },
  };

  private proxyFetch = getProxyFetch(VIDEO_TIMEOUT_MS);

  async startVideo(prompt: string, options?: VideoOptions): Promise<VideoJob> {
    // Veo 3.1 requires an even number of seconds (4, 6, or 8).
    // Round up any odd input to the next even value.
    const rawDuration = options?.duration || DEFAULT_VIDEO_DURATION_S;
    const duration = rawDuration % 2 !== 0 ? rawDuration + 1 : rawDuration;

    // Validate prompt
    if (!prompt?.trim()) {
      throw new Error("Prompt cannot be empty");
    }

    // Validate duration
    const maxDuration = this.capabilities.video?.maxDurationSeconds || 8;
    if (duration > maxDuration) {
      throw new Error(`Duration ${duration}s exceeds maximum ${maxDuration}s`);
    }
    if (duration < 4) {
      throw new Error(`Duration must be at least 4 seconds for Veo`);
    }

    // Validate aspect ratio
    const aspectRatio = options?.aspectRatio || "16:9";
    const supportedRatios = this.capabilities.video?.supportedAspectRatios || [];
    if (supportedRatios.length > 0 && !supportedRatios.includes(aspectRatio)) {
      throw new Error(
        `Invalid aspect ratio: ${aspectRatio}. Supported: ${supportedRatios.join(", ")}`
      );
    }

    // Start the video generation using Veo API
    // Using predictLongRunning endpoint for async video generation
    const url = `${VEO_API_BASE}/models/${VEO_MODEL}:predictLongRunning`;

    let response;
    try {
      response = await this.proxyFetch(url, {
        method: "POST",
        headers: veoAuthHeaders(),
        body: JSON.stringify({
          instances: [
            {
              prompt,
              ...(options?.firstFrame && {
                image: {
                  bytesBase64Encoded: options.firstFrame.toString("base64"),
                  mimeType: "image/jpeg",
                },
              }),
            },
          ],
          parameters: {
            durationSeconds: duration,
            aspectRatio,
          },
        }),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to start video generation: ${message}`);
    }

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Veo API error: ${response.status} - ${errorText}`
      );
    }

    const data = await safeJsonParse<{
      name?: string;
      metadata?: Record<string, unknown>;
    }>(response);

    // The API returns an operation name for polling
    if (!data.name) {
      throw new Error("Veo API did not return an operation name");
    }
    const operationName = data.name;

    return {
      id: operationName,
      status: "pending",
      prompt,
      adapter: this.name,
      createdAt: new Date().toISOString(),
    };
  }

  async pollVideo(jobId: string): Promise<VideoJob> {
    // Poll the operation status
    // The jobId is the operation name returned from startVideo
    // Format: "models/<model>/operations/<id>" or "operations/<id>"
    // Validate format to prevent injection while allowing the expected path structure
    const OPERATION_NAME_PATTERN = /^(models\/[a-zA-Z0-9._-]+\/)?operations\/[a-zA-Z0-9_-]+$/;
    if (!OPERATION_NAME_PATTERN.test(jobId)) {
      throw new Error(
        `Invalid operation name format: ${jobId}. Expected format: models/<model>/operations/<id> or operations/<id>`
      );
    }
    const url = `${VEO_API_BASE}/${jobId}`;

    let response;
    try {
      response = await this.proxyFetch(url, {
        method: "GET",
        headers: veoAuthHeaders(),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to poll video status: ${message}`);
    }

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Veo API error: ${response.status} - ${errorText}`);
    }

    const operation = await safeJsonParse<{
      name?: string;
      done?: boolean;
      error?: { message?: string; code?: number };
      response?: {
        // Veo 3.1 response format
        generateVideoResponse?: {
          generatedSamples?: Array<{
            video?: { uri?: string };
          }>;
          raiMediaFilteredCount?: number;
          raiMediaFilteredReasons?: string[];
        };
        // Veo 2.0 response format
        generatedVideos?: Array<{
          video?: { uri?: string };
        }>;
      };
      metadata?: Record<string, unknown>;
    }>(response);

    // Debug: log the actual response structure
    if (process.env.DEBUG_VEO) {
      console.error("DEBUG VEO RESPONSE:", JSON.stringify(operation, null, 2));
    }

    if (operation.done) {
      if (operation.error) {
        return {
          id: jobId,
          status: "failed",
          prompt: "",
          adapter: this.name,
          createdAt: "",
          error: operation.error.message || "Unknown error",
        };
      }

      // Extract video URL from response - handle both Veo 3.1 and Veo 2.0 formats
      const videoUrl =
        operation.response?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri ||
        operation.response?.generatedVideos?.[0]?.video?.uri;

      if (!videoUrl) {
        const filterReasons =
          operation.response?.generateVideoResponse?.raiMediaFilteredReasons;
        const error =
          filterReasons?.length
            ? filterReasons.join(" ")
            : "No video URL in response";
        return {
          id: jobId,
          status: "failed",
          prompt: "",
          adapter: this.name,
          createdAt: "",
          error,
        };
      }

      // Calculate expiration using capability constant
      const expirationHours = this.capabilities.video?.expirationHours || 48;
      const expiresAt = new Date(
        Date.now() + expirationHours * 60 * 60 * 1000
      ).toISOString();

      return {
        id: jobId,
        status: "completed",
        prompt: "",
        adapter: this.name,
        createdAt: "",
        completedAt: new Date().toISOString(),
        result: {
          url: videoUrl,
          mimeType: "video/mp4",
          expiresAt,
        },
      };
    }

    // Still processing
    return {
      id: jobId,
      status: "processing",
      prompt: "",
      adapter: this.name,
      createdAt: "",
    };
  }

  estimateCost(
    modality: Modality,
    options: Record<string, unknown>
  ): CostEstimate {
    if (modality !== "video") {
      return { min: 0, max: 0, currency: "USD", breakdown: "N/A" };
    }

    const duration = (options.duration as number) || DEFAULT_VIDEO_DURATION_S;
    const cost = duration * VEO_PRICE_PER_SECOND;

    return {
      min: cost,
      max: cost,
      currency: "USD",
      breakdown: `${duration}s video @ $${VEO_PRICE_PER_SECOND}/s = $${cost.toFixed(2)}`,
    };
  }
}
