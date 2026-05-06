/**
 * OpenAI adapter for image and audio generation
 *
 * Uses Vercel AI SDK for image generation (DALL-E 3)
 * Uses direct OpenAI API for audio (TTS)
 */

import { createOpenAI } from "@ai-sdk/openai";
import { experimental_generateImage as generateImage } from "ai";
import type {
  MediaAdapter,
  AdapterCapabilities,
  PricingInfo,
  ImageOptions,
  AudioOptions,
  GeneratedImage,
  GeneratedAudio,
  CostEstimate,
} from "./types.js";
import type { Modality } from "../config.js";
import { getProxyFetch } from "../utils/fetch.js";
import { isInterceptorActive } from "../utils/auth.js";
import { AUDIO_TIMEOUT_MS, DEFAULT_VOICE, MODEL_LIMITS } from "../config.js";

// DALL-E 3 pricing (as of Jan 2025)
const DALLE3_PRICING: Record<string, number> = {
  "1024x1024": 0.04,
  "1024x1792": 0.08,
  "1792x1024": 0.08,
};

const DALLE3_HD_PRICING: Record<string, number> = {
  "1024x1024": 0.08,
  "1024x1792": 0.12,
  "1792x1024": 0.12,
};

// TTS pricing: $15 per 1M characters = $0.015 per 1K chars
const TTS_PRICE_PER_1K_CHARS = 0.015;

export class OpenAIAdapter implements MediaAdapter {
  readonly name = "openai";

  readonly capabilities: AdapterCapabilities = {
    modalities: ["image", "audio"],
    image: {
      supportedSizes: ["1024x1024", "1024x1792", "1792x1024"],
      maxCount: 10, // DALL-E 3 API only supports n=1, but we loop for multiple
    },
    audio: {
      voices: ["alloy", "echo", "fable", "onyx", "nova", "shimmer"],
      formats: ["mp3", "opus", "aac", "flac", "wav", "pcm"],
      maxLengthCharacters: 4096,
    },
  };

  readonly pricing: PricingInfo = {
    image: { perImage: DALLE3_PRICING },
    audio: { perThousandChars: TTS_PRICE_PER_1K_CHARS },
  };

  private openai;

  constructor() {
    // Initialize lazily - don't require API key at construction
    this.openai = null as ReturnType<typeof createOpenAI> | null;
  }

  private getOpenAI() {
    if (!this.openai) {
      if (isInterceptorActive()) {
        // When interceptor is active, pass a custom fetch that adds X-Resource header.
        // The proxy will override the Authorization header the SDK sets.
        this.openai = createOpenAI({
          apiKey: "proxy-managed",
          fetch: (input, init) => {
            const headers = new Headers(init?.headers);
            headers.set("X-Resource", "openai-api-key");
            return globalThis.fetch(input, { ...init, headers });
          },
        });
      } else {
        const apiKey = process.env.OPENAI_API_KEY;
        if (!apiKey) {
          throw new Error("OPENAI_API_KEY environment variable not set");
        }
        this.openai = createOpenAI({ apiKey });
      }
    }
    return this.openai;
  }

  async generateImage(
    prompt: string,
    options?: ImageOptions
  ): Promise<GeneratedImage[]> {
    const openai = this.getOpenAI();
    const size = options?.size || "1024x1024";

    // Validate prompt
    if (!prompt?.trim()) {
      throw new Error("Prompt cannot be empty");
    }

    // Validate size
    if (!this.capabilities.image?.supportedSizes.includes(size)) {
      throw new Error(
        `Invalid size: ${size}. Supported: ${this.capabilities.image?.supportedSizes.join(", ")}`
      );
    }

    // Validate prompt length
    if (prompt.length > MODEL_LIMITS.DALLE3_MAX_PROMPT_LENGTH) {
      throw new Error(
        `Prompt length ${prompt.length} exceeds maximum ${MODEL_LIMITS.DALLE3_MAX_PROMPT_LENGTH} characters`
      );
    }

    // DALL-E 3 API only supports n=1 per request, so we loop for multiple images
    const count = options?.count || 1;
    const maxCount = this.capabilities.image?.maxCount || 10;
    if (count < 1 || count > maxCount) {
      throw new Error(`Count must be between 1 and ${maxCount}, got ${count}`);
    }
    const results: GeneratedImage[] = [];

    for (let i = 0; i < count; i++) {
      const result = await generateImage({
        model: openai.image("dall-e-3"),
        prompt,
        size: size as "1024x1024" | "1024x1792" | "1792x1024",
        n: 1,
      });

      for (const image of result.images) {
        const [width, height] = size.split("x").map(Number);
        // Cast to access revisedPrompt which may exist on some providers
        const imageAny = image as { uint8Array: Uint8Array; revisedPrompt?: string };
        results.push({
          data: Buffer.from(imageAny.uint8Array),
          mimeType: "image/png",
          width,
          height,
          revisedPrompt: imageAny.revisedPrompt,
        });
      }
    }

    return results;
  }

  async generateAudio(
    text: string,
    options?: AudioOptions
  ): Promise<GeneratedAudio> {
    const voice = options?.voice || DEFAULT_VOICE;
    const format = options?.format || "mp3";
    const speed = options?.speed || 1.0;

    // Validate text not empty
    if (!text?.trim()) {
      throw new Error("Text cannot be empty");
    }

    // Validate text length
    if (text.length > MODEL_LIMITS.OPENAI_TTS_MAX_LENGTH) {
      throw new Error(
        `Text length ${text.length} exceeds maximum ${MODEL_LIMITS.OPENAI_TTS_MAX_LENGTH} characters`
      );
    }

    // Validate speed (OpenAI supports 0.25 to 4.0)
    if (speed < 0.25 || speed > 4.0) {
      throw new Error(`Invalid speed: ${speed}. Must be between 0.25 and 4.0`);
    }

    // Validate voice
    if (!this.capabilities.audio?.voices.includes(voice)) {
      throw new Error(
        `Invalid voice: ${voice}. Supported: ${this.capabilities.audio?.voices.join(", ")}`
      );
    }

    // Validate format
    if (!this.capabilities.audio?.formats.includes(format)) {
      throw new Error(
        `Invalid format: ${format}. Supported: ${this.capabilities.audio?.formats.join(", ")}`
      );
    }

    // Build auth headers
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (isInterceptorActive()) {
      headers["X-Resource"] = "openai-api-key";
    } else {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) {
        throw new Error("OPENAI_API_KEY environment variable not set");
      }
      headers["Authorization"] = `Bearer ${apiKey}`;
    }

    const proxyFetch = getProxyFetch(AUDIO_TIMEOUT_MS);
    const response = await proxyFetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "tts-1",
        input: text,
        voice,
        response_format: format,
        speed,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenAI TTS error: ${response.status} - ${error}`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    const mimeType =
      format === "mp3"
        ? "audio/mpeg"
        : format === "wav"
          ? "audio/wav"
          : `audio/${format}`;

    return {
      data: buffer,
      mimeType,
    };
  }

  estimateCost(
    modality: Modality,
    options: Record<string, unknown>
  ): CostEstimate {
    if (modality === "image") {
      const size = (options.size as string) || "1024x1024";
      const quality = (options.quality as string) || "standard";
      const count = (options.count as number) || 1;

      const pricing = quality === "hd" ? DALLE3_HD_PRICING : DALLE3_PRICING;
      const perImage = pricing[size] || DALLE3_PRICING["1024x1024"];
      const total = perImage * count;

      return {
        min: total,
        max: total,
        currency: "USD",
        breakdown: `${count} image${count > 1 ? "s" : ""} @ $${perImage.toFixed(2)} = $${total.toFixed(2)}`,
      };
    }

    if (modality === "audio") {
      const text = options.text as string;
      const chars = text?.length || 0;
      const cost = (chars / 1000) * TTS_PRICE_PER_1K_CHARS;

      return {
        min: cost,
        max: cost,
        currency: "USD",
        breakdown: `${chars} characters @ $${TTS_PRICE_PER_1K_CHARS}/1K = $${cost.toFixed(4)}`,
      };
    }

    return { min: 0, max: 0, currency: "USD", breakdown: "N/A" };
  }
}
