/**
 * fal.ai adapter for video generation
 *
 * Uses fal.ai's Veo 3.1 Fast endpoint for image-to-video with audio and lipsync.
 * Video generation is async - start job, poll for completion.
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

// fal.ai Veo 3.1 Fast pricing
const FAL_PRICE_PER_SECOND_NO_AUDIO = 0.10;
const FAL_PRICE_PER_SECOND_WITH_AUDIO = 0.15;

// fal.ai API base URLs
const FAL_REST_BASE = "https://rest.fal.ai";
// Separate endpoints for text-to-video vs image-to-video (submission only)
const FAL_TEXT_TO_VIDEO = "https://queue.fal.run/fal-ai/veo3.1/fast";
const FAL_IMAGE_TO_VIDEO = "https://queue.fal.run/fal-ai/veo3.1/fast/image-to-video";
// Poll/result URLs use the base model path (without /fast — /fast variant returns 405)
const FAL_QUEUE_POLL_BASE = "https://queue.fal.run/fal-ai/veo3.1";

/**
 * Build auth headers for fal.ai API requests.
 * With interceptor: sets X-Resource header for proxy auth injection.
 * Without interceptor: sets Authorization: Key header directly.
 */
function falAuthHeaders(extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = { ...extra };

  if (isInterceptorActive()) {
    headers["X-Resource"] = "fal-ai-key";
  } else {
    const apiKey = process.env.FAL_KEY;
    if (!apiKey) {
      throw new Error("FAL_KEY environment variable not set");
    }
    headers["Authorization"] = `Key ${apiKey}`;
  }

  return headers;
}

export class FalAdapter implements MediaAdapter {
  readonly name = "fal";

  readonly capabilities: AdapterCapabilities = {
    modalities: ["video"],
    video: {
      maxDurationSeconds: 8,
      supportedAspectRatios: ["16:9", "9:16"],
      outputExpires: true,
      expirationHours: 168, // fal files retained 7 days
      generatesAudio: true,
      supportsFirstFrame: true,
    },
  };

  readonly pricing: PricingInfo = {
    video: { perSecond: FAL_PRICE_PER_SECOND_WITH_AUDIO },
  };

  private proxyFetch = getProxyFetch(VIDEO_TIMEOUT_MS);

  /**
   * Upload an image buffer to fal.ai storage, returning a public URL.
   * fal.ai requires a public URL for image-to-video; it does not accept base64.
   * Uses the two-step initiate -> PUT upload flow from the fal.ai REST API.
   */
  private async uploadImage(imageBuffer: Buffer): Promise<string> {
    const contentType = "image/jpeg";

    // Step 1: Initiate upload to get a pre-signed upload URL
    let initiateResponse;
    try {
      initiateResponse = await this.proxyFetch(
        `${FAL_REST_BASE}/storage/upload/initiate?storage_type=fal-cdn-v3`,
        {
          method: "POST",
          headers: falAuthHeaders({ "Content-Type": "application/json" }),
          body: JSON.stringify({
            content_type: contentType,
            file_name: `frame-${Date.now()}.jpg`,
          }),
        }
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to initiate fal.ai upload: ${message}`);
    }

    if (!initiateResponse.ok) {
      const errorText = await initiateResponse.text();
      throw new Error(`fal.ai upload initiate error: ${initiateResponse.status} - ${errorText}`);
    }

    const { upload_url: uploadUrl, file_url: fileUrl } = await safeJsonParse<{
      upload_url?: string;
      file_url?: string;
    }>(initiateResponse);

    if (!uploadUrl || !fileUrl) {
      throw new Error("fal.ai upload initiate did not return upload_url/file_url");
    }

    // Step 2: PUT the binary to the pre-signed URL
    // Pre-signed PUT does not need auth headers
    let putResponse;
    try {
      putResponse = await this.proxyFetch(uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": contentType },
        body: new Uint8Array(imageBuffer),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to upload image to fal.ai: ${message}`);
    }

    if (!putResponse.ok) {
      const errorText = await putResponse.text();
      throw new Error(`fal.ai upload PUT error: ${putResponse.status} - ${errorText}`);
    }

    return fileUrl;
  }

  async startVideo(prompt: string, options?: VideoOptions): Promise<VideoJob> {
    const duration = options?.duration || DEFAULT_VIDEO_DURATION_S;
    const generateAudio = options?.generateAudio ?? true;

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
      throw new Error("Duration must be at least 4 seconds for fal.ai Veo");
    }

    // Validate aspect ratio
    const aspectRatio = options?.aspectRatio || "9:16";
    const supportedRatios = this.capabilities.video?.supportedAspectRatios || [];
    if (supportedRatios.length > 0 && !supportedRatios.includes(aspectRatio)) {
      throw new Error(
        `Invalid aspect ratio: ${aspectRatio}. Supported: ${supportedRatios.join(", ")}`
      );
    }

    // Upload first frame if provided (fal requires a URL, not base64)
    let imageUrl: string | undefined;
    if (options?.firstFrame) {
      imageUrl = await this.uploadImage(options.firstFrame);
    }

    // fal.ai duration format is a string: "8s"
    const durationStr = `${duration}s`;

    // Use image-to-video endpoint only when a first frame is provided
    const queueUrl = imageUrl ? FAL_IMAGE_TO_VIDEO : FAL_TEXT_TO_VIDEO;

    let response;
    try {
      response = await this.proxyFetch(queueUrl, {
        method: "POST",
        headers: falAuthHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          prompt,
          ...(imageUrl && { image_url: imageUrl }),
          generate_audio: generateAudio,
          aspect_ratio: aspectRatio,
          duration: durationStr,
          resolution: "720p",
          safety_tolerance: "4",
          auto_fix: true,
        }),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to start video generation: ${message}`);
    }

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`fal.ai API error: ${response.status} - ${errorText}`);
    }

    const data = await safeJsonParse<{ request_id?: string }>(response);
    if (!data.request_id) {
      throw new Error("fal.ai API did not return a request_id");
    }

    return {
      id: data.request_id,
      status: "pending",
      prompt,
      adapter: this.name,
      createdAt: new Date().toISOString(),
    };
  }

  async pollVideo(jobId: string): Promise<VideoJob> {
    // Validate job ID format to prevent injection
    const REQUEST_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;
    if (!REQUEST_ID_PATTERN.test(jobId)) {
      throw new Error(`Invalid fal.ai request_id format: ${jobId}`);
    }

    // Poll URLs use the base model path (without /fast) — /fast variant returns 405
    const statusUrl = `${FAL_QUEUE_POLL_BASE}/requests/${jobId}/status`;
    let statusResponse;
    try {
      statusResponse = await this.proxyFetch(statusUrl, {
        method: "GET",
        headers: falAuthHeaders(),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to poll video status: ${message}`);
    }

    if (!statusResponse.ok) {
      const errorText = await statusResponse.text();
      throw new Error(`fal.ai poll error: ${statusResponse.status} - ${errorText}`);
    }

    const status = await safeJsonParse<{
      status?: string;
      error?: string;
    }>(statusResponse);

    if (status.status === "FAILED") {
      return {
        id: jobId,
        status: "failed",
        prompt: "",
        adapter: this.name,
        createdAt: "",
        error: status.error || "Video generation failed",
      };
    }

    if (status.status !== "COMPLETED") {
      return {
        id: jobId,
        status: "processing",
        prompt: "",
        adapter: this.name,
        createdAt: "",
      };
    }

    // Fetch result (also uses base model path without /fast)
    const resultUrl = `${FAL_QUEUE_POLL_BASE}/requests/${jobId}`;
    let resultResponse;
    try {
      resultResponse = await this.proxyFetch(resultUrl, {
        method: "GET",
        headers: falAuthHeaders(),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to fetch video result: ${message}`);
    }

    if (!resultResponse.ok) {
      const errorText = await resultResponse.text();
      throw new Error(`fal.ai result error: ${resultResponse.status} - ${errorText}`);
    }

    const result = await safeJsonParse<{
      video?: { url?: string; file_size?: number };
    }>(resultResponse);

    const videoUrl = result.video?.url;
    if (!videoUrl) {
      return {
        id: jobId,
        status: "failed",
        prompt: "",
        adapter: this.name,
        createdAt: "",
        error: "No video URL in fal.ai result",
      };
    }

    const expirationHours = this.capabilities.video?.expirationHours || 168;
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

  estimateCost(
    modality: Modality,
    options: Record<string, unknown>
  ): CostEstimate {
    if (modality !== "video") {
      return { min: 0, max: 0, currency: "USD", breakdown: "N/A" };
    }

    const duration = (options.duration as number) || DEFAULT_VIDEO_DURATION_S;
    const generateAudio = options.generateAudio !== false;
    const pricePerSecond = generateAudio
      ? FAL_PRICE_PER_SECOND_WITH_AUDIO
      : FAL_PRICE_PER_SECOND_NO_AUDIO;
    const cost = duration * pricePerSecond;

    return {
      min: cost,
      max: cost,
      currency: "USD",
      breakdown: `${duration}s video @ $${pricePerSecond}/s (audio ${generateAudio ? "on" : "off"}) = $${cost.toFixed(2)}`,
    };
  }
}
