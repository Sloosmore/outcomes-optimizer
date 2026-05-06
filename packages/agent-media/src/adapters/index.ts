/**
 * Adapter registration
 *
 * All adapters are registered here at module load time.
 */

import { adapterRegistry } from "./registry.js";
import { OpenAIAdapter } from "./openai.js";
import { GoogleAdapter } from "./google.js";
import { GeminiImageAdapter } from "./gemini.js";
import { FalAdapter } from "./fal.js";

// Register Gemini adapter (image via Imagen / Nano Banana)
adapterRegistry.register("gemini", {
  adapter: new GeminiImageAdapter(),
  description: "Google Imagen 3 (Nano Banana) for image generation",
  requiresAuth: true,
  authEnvVars: ["GOOGLE_API_KEY", "GEMINI_API_KEY"],
  ciCompatible: false,
});

// Register OpenAI adapter (image + audio)
adapterRegistry.register("openai", {
  adapter: new OpenAIAdapter(),
  description: "OpenAI DALL-E 3 for images, TTS for audio",
  requiresAuth: true,
  authEnvVars: ["OPENAI_API_KEY"],
  ciCompatible: false,
});

// Register Google adapter (video via Veo 3.1)
adapterRegistry.register("google", {
  adapter: new GoogleAdapter(),
  description: "Google Veo 3.1 for video generation (9:16 vertical supported)",
  requiresAuth: true,
  authEnvVars: ["GOOGLE_API_KEY", "GEMINI_API_KEY"],
  ciCompatible: false,
});

// Register fal.ai adapter (video via Veo 3.1 Fast with audio + lipsync)
adapterRegistry.register("fal", {
  adapter: new FalAdapter(),
  description: "fal.ai Veo 3.1 Fast — image-to-video with audio and lipsync (9:16 vertical)",
  requiresAuth: true,
  authEnvVars: ["FAL_KEY"],
  ciCompatible: true,
});

// Set defaults for each modality
// Use Gemini (Imagen) for images, OpenAI for audio, Google (Veo) for video
adapterRegistry.setDefault("image", "gemini");
adapterRegistry.setDefault("audio", "openai");
adapterRegistry.setDefault("video", "google");

// Re-export registry
export { adapterRegistry } from "./registry.js";

// Re-export types
export type {
  MediaAdapter,
  AdapterCapabilities,
  PricingInfo,
  ImageOptions,
  AudioOptions,
  VideoOptions,
  GeneratedImage,
  GeneratedAudio,
  VideoJob,
  CostEstimate,
} from "./types.js";
