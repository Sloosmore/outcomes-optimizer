/**
 * Core types for media adapters
 */

import type { Modality } from "../config.js";

/**
 * Adapter capabilities - what this adapter can do
 */
export interface AdapterCapabilities {
  /** Supported modalities */
  modalities: Modality[];

  /** Image generation capabilities */
  image?: {
    supportedSizes: string[];
    maxCount: number;
    supportsNegativePrompt?: boolean;
  };

  /** Video generation capabilities */
  video?: {
    maxDurationSeconds: number;
    supportedAspectRatios?: string[];
    outputExpires: boolean;
    expirationHours?: number;
    /** Whether the model generates an audio track alongside the video */
    generatesAudio?: boolean;
    /** Whether the adapter supports image-to-video via firstFrame option */
    supportsFirstFrame?: boolean;
  };

  /** Audio generation capabilities */
  audio?: {
    voices: string[];
    maxLengthCharacters?: number;
    formats: string[];
  };
}

/**
 * Pricing information for cost estimation
 */
export interface PricingInfo {
  image?: {
    /** Cost per image by size */
    perImage: Record<string, number>;
  };
  video?: {
    /** Cost per second of video */
    perSecond: number;
  };
  audio?: {
    /** Cost per 1000 characters */
    perThousandChars: number;
  };
}

/**
 * Cost estimate result
 */
export interface CostEstimate {
  min: number;
  max: number;
  currency: "USD";
  breakdown: string;
}

/**
 * Generated media result
 */
export interface GeneratedMedia {
  /** Binary data (if available directly) */
  data?: Buffer;
  /** URL to download (may expire) */
  url?: string;
  /** MIME type */
  mimeType: string;
  /** Local path after saving */
  localPath?: string;
}

/**
 * Generated image result
 */
export interface GeneratedImage extends GeneratedMedia {
  /** Image width */
  width?: number;
  /** Image height */
  height?: number;
  /** Revised prompt (some APIs modify the prompt) */
  revisedPrompt?: string;
}

/**
 * Generated audio result
 */
export interface GeneratedAudio extends GeneratedMedia {
  /** Duration in seconds */
  duration?: number;
}

/**
 * Video generation job (async operation)
 */
export interface VideoJob {
  /** Job ID from the provider */
  id: string;
  /** Current status */
  status: "pending" | "processing" | "completed" | "failed";
  /** Original prompt */
  prompt: string;
  /** Adapter that created this job */
  adapter: string;
  /** When the job was created */
  createdAt: string;
  /** When the job completed */
  completedAt?: string;
  /** Result when completed */
  result?: {
    url: string;
    mimeType?: string;
    duration?: number;
    expiresAt?: string;
    localPath?: string;
  };
  /** Error message if failed */
  error?: string;
}

/**
 * Options for image generation
 */
export interface ImageOptions {
  /** Image size (e.g., "1024x1024") */
  size?: string;
  /** Number of images to generate */
  count?: number;
  /** Image quality */
  quality?: "standard" | "hd";
  /** Style preference */
  style?: "natural" | "vivid";
}

/**
 * Options for video generation
 */
export interface VideoOptions {
  /** Duration in seconds */
  duration?: number;
  /** Aspect ratio (e.g., "16:9") */
  aspectRatio?: string;
  /** First frame image data for image-to-video generation */
  firstFrame?: Buffer;
  /** Whether to generate an audio track (supported by some adapters) */
  generateAudio?: boolean;
}

/**
 * Options for audio generation
 */
export interface AudioOptions {
  /** Voice to use */
  voice?: string;
  /** Output format */
  format?: string;
  /** Speech speed (0.25 to 4.0) */
  speed?: number;
}

/**
 * Media adapter interface
 *
 * Adapters provide generation capabilities for one or more modalities.
 * Unlike email adapters, media adapters don't need session management
 * for sync operations (image/audio). Video uses job tracking.
 */
export interface MediaAdapter {
  /** Human-readable name */
  readonly name: string;

  /** What this adapter can do */
  readonly capabilities: AdapterCapabilities;

  /** Pricing information */
  readonly pricing: PricingInfo;

  /**
   * Generate images from a text prompt
   */
  generateImage?(
    prompt: string,
    options?: ImageOptions
  ): Promise<GeneratedImage[]>;

  /**
   * Generate audio from text (TTS)
   */
  generateAudio?(text: string, options?: AudioOptions): Promise<GeneratedAudio>;

  /**
   * Start video generation (async operation)
   * Returns a job ID that can be polled
   */
  startVideo?(prompt: string, options?: VideoOptions): Promise<VideoJob>;

  /**
   * Poll video generation status
   */
  pollVideo?(jobId: string): Promise<VideoJob>;

  /**
   * Estimate cost for a generation
   */
  estimateCost(
    modality: Modality,
    options: Record<string, unknown>
  ): CostEstimate;
}
