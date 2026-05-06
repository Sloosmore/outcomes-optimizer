/**
 * Bulk image generation command
 *
 * Generates images from multiple prompts in parallel with configurable concurrency.
 */

import { adapterRegistry } from "../adapters/index.js";
import { saveMedia } from "../utils/output.js";
import {
  DEFAULT_IMAGE_SIZE,
  DEFAULT_MAX_COST_USD,
  EXIT_CODES,
  DEFAULT_BULK_CONCURRENCY,
  MAX_BULK_CONCURRENCY,
  MAX_BULK_PROMPTS,
  DEFAULT_BULK_DELAY_MS,
} from "../config.js";
import type { ImageOptions } from "../adapters/types.js";
import { readFile } from "node:fs/promises";

export interface BulkImagePrompt {
  /** The prompt text for image generation */
  prompt: string;
  /** Optional override for size (e.g., "1024x1024" or "16:9") */
  size?: string;
  /** Optional override for quality */
  quality?: "standard" | "hd";
  /** Optional override for style */
  style?: "natural" | "vivid";
  /** Optional output filename/path for this specific image */
  output?: string;
}

export interface BulkImageResult {
  /** Original prompt */
  prompt: string;
  /** Whether generation succeeded */
  success: boolean;
  /** Path to saved file (if successful) */
  path?: string;
  /** Error message (if failed) */
  error?: string;
  /** Revised prompt from the model (if available) */
  revisedPrompt?: string;
  /** Image dimensions */
  size?: string;
}

export interface BulkImageCommandOptions {
  adapter?: string;
  size?: string;
  quality?: "standard" | "hd";
  style?: "natural" | "vivid";
  output?: string;
  dryRun?: boolean;
  maxCost?: number;
  force?: boolean;
  json?: boolean;
  concurrency?: number;
  delay?: number;
}

/**
 * Parse a single prompt item (string or object) into BulkImagePrompt
 */
function parsePromptItem(item: unknown, index: number): BulkImagePrompt {
  if (typeof item === "string") {
    if (!item.trim()) {
      throw new Error(`Invalid prompt at index ${index}: prompt cannot be empty`);
    }
    return { prompt: item };
  }
  if (typeof item === "object" && item !== null && "prompt" in item) {
    const obj = item as Record<string, unknown>;
    if (typeof obj.prompt !== "string" || !obj.prompt.trim()) {
      throw new Error(`Invalid prompt at index ${index}: prompt must be a non-empty string`);
    }
    return {
      prompt: obj.prompt,
      size: typeof obj.size === "string" ? obj.size : undefined,
      quality: obj.quality === "standard" || obj.quality === "hd" ? obj.quality : undefined,
      style: obj.style === "natural" || obj.style === "vivid" ? obj.style : undefined,
      output: typeof obj.output === "string" ? obj.output : undefined,
    };
  }
  throw new Error(`Invalid prompt at index ${index}: must be a string or object with "prompt" field`);
}

/**
 * Parse JSONL content - one JSON object per line
 */
function parseJsonl(content: string, filename: string): BulkImagePrompt[] {
  const lines = content.split("\n");
  const prompts: BulkImagePrompt[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    // Skip empty lines and comments
    if (!line || line.startsWith("#") || line.startsWith("//")) {
      continue;
    }
    try {
      const parsed = JSON.parse(line);
      prompts.push(parsePromptItem(parsed, prompts.length));
    } catch (e) {
      throw new Error(
        `Invalid JSON on line ${i + 1} of "${filename}": ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }

  return prompts;
}

/**
 * Detect file format from extension or content
 */
function detectFileFormat(filename: string, content: string): "json" | "jsonl" | "text" {
  const ext = filename.toLowerCase().split(".").pop();
  if (ext === "jsonl" || ext === "ndjson") {
    return "jsonl";
  }
  if (ext === "json") {
    return "json";
  }
  // Auto-detect from content
  const trimmed = content.trim();
  if (trimmed.startsWith("[")) {
    return "json";
  }
  if (trimmed.startsWith("{")) {
    return "jsonl";
  }
  return "text";
}

/**
 * Parse prompts input - accepts multiple formats:
 *
 * CLI Arguments:
 *   image-bulk "prompt1" "prompt2" "prompt3"
 *
 * Text file (.txt) - one prompt per line:
 *   a red circle
 *   a blue square
 *
 * JSONL file (.jsonl) - one JSON object per line (RECOMMENDED for agents):
 *   {"prompt": "a red circle"}
 *   {"prompt": "a blue square", "size": "1024x1024"}
 *
 * JSON file (.json) - array format:
 *   ["prompt1", "prompt2"]
 *   or
 *   [{"prompt": "...", "size": "..."}, ...]
 */
async function parsePromptsInput(
  input: string | string[]
): Promise<BulkImagePrompt[]> {
  let data: unknown[] | null = null;

  // If input is already an array (from variadic CLI args), use it directly
  if (Array.isArray(input)) {
    if (input.length === 0) {
      throw new Error(
        "No prompts provided.\n\n" +
        "Usage:\n" +
        "  image-bulk \"prompt1\" \"prompt2\"      Multiple arguments\n" +
        "  image-bulk prompts.jsonl             JSONL file (recommended)\n" +
        "  image-bulk prompts.txt               Text file (one per line)\n" +
        "  image-bulk prompts.json              JSON array file\n\n" +
        "Run 'image-bulk --help' for format details."
      );
    }
    // If single item, it might be a file path
    if (input.length === 1) {
      return parsePromptsInput(input[0]);
    }
    // Multiple args = direct prompts
    data = input;
  } else {
    // Single string input
    const trimmed = input.trim();

    // Try to parse as inline JSON array first
    if (trimmed.startsWith("[")) {
      try {
        const parsed = JSON.parse(trimmed);
        if (!Array.isArray(parsed)) {
          throw new Error("Input must be a JSON array");
        }
        data = parsed;
      } catch (e) {
        throw new Error(`Invalid JSON input: ${e instanceof Error ? e.message : String(e)}`);
      }
    } else {
      // Treat as file path
      let fileContent: string;
      try {
        fileContent = await readFile(input, "utf-8");
      } catch (e) {
        throw new Error(`Failed to read file "${input}": ${e instanceof Error ? e.message : String(e)}`);
      }

      const format = detectFileFormat(input, fileContent);

      if (format === "jsonl") {
        const prompts = parseJsonl(fileContent, input);
        if (prompts.length === 0) {
          throw new Error(`File "${input}" contains no valid prompts`);
        }
        if (prompts.length > MAX_BULK_PROMPTS) {
          throw new Error(`File contains ${prompts.length} prompts, max is ${MAX_BULK_PROMPTS}`);
        }
        return prompts;
      }

      if (format === "json") {
        try {
          const parsed = JSON.parse(fileContent);
          if (!Array.isArray(parsed)) {
            throw new Error("JSON file must contain an array");
          }
          data = parsed;
        } catch (e) {
          throw new Error(`Invalid JSON in file "${input}": ${e instanceof Error ? e.message : String(e)}`);
        }
      } else {
        // Text file - one prompt per line
        const lines = fileContent
          .split("\n")
          .map(line => line.trim())
          .filter(line => line.length > 0 && !line.startsWith("#"));

        if (lines.length === 0) {
          throw new Error(`File "${input}" contains no prompts (empty or all comments)`);
        }
        data = lines;
      }
    }
  }

  // Validate and normalize
  if (!data || data.length === 0) {
    throw new Error("No prompts provided");
  }

  if (data.length > MAX_BULK_PROMPTS) {
    throw new Error(`Too many prompts (${data.length}), max is ${MAX_BULK_PROMPTS}`);
  }

  return data.map((item, index) => parsePromptItem(item, index));
}

/**
 * Sleep for a given number of milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run async tasks with concurrency limit and optional delay between requests
 */
async function runWithConcurrency<T, R>(
  items: T[],
  fn: (item: T, index: number) => Promise<R>,
  concurrency: number,
  delayMs: number = 0
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let currentIndex = 0;

  async function worker(): Promise<void> {
    while (currentIndex < items.length) {
      const index = currentIndex++;
      results[index] = await fn(items[index], index);
      // Add delay between requests if specified (helps with rate limiting)
      if (delayMs > 0 && currentIndex < items.length) {
        await sleep(delayMs);
      }
    }
  }

  // Start workers up to concurrency limit
  const workers: Promise<void>[] = [];
  for (let i = 0; i < Math.min(concurrency, items.length); i++) {
    workers.push(worker());
  }

  await Promise.all(workers);
  return results;
}

export async function bulkImageCommand(
  promptsInput: string | string[],
  options: BulkImageCommandOptions
): Promise<void> {
  const adapterName = options.adapter || adapterRegistry.getDefault("image");

  // Check auth
  const authCheck = adapterRegistry.checkAuth(adapterName);
  if (!authCheck.ok) {
    console.error(
      `Error: Missing environment variable(s): ${authCheck.missing.join(", ")}`
    );
    process.exit(EXIT_CODES.CONFIG_ERROR);
  }

  const adapter = adapterRegistry.get(adapterName);

  // Check adapter supports image
  if (!adapter.capabilities.modalities.includes("image")) {
    console.error(
      `Error: Adapter "${adapterName}" does not support image generation`
    );
    process.exit(EXIT_CODES.CONFIG_ERROR);
  }

  if (!adapter.generateImage) {
    console.error(
      `Error: Adapter "${adapterName}" does not implement generateImage`
    );
    process.exit(EXIT_CODES.CONFIG_ERROR);
  }
  // Save reference after validation (helps TypeScript narrowing)
  const generateImage = adapter.generateImage.bind(adapter);

  // Parse prompts
  let prompts: BulkImagePrompt[];
  try {
    prompts = await parsePromptsInput(promptsInput);
  } catch (e) {
    console.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(EXIT_CODES.CONFIG_ERROR);
  }

  const requestedConcurrency = options.concurrency || DEFAULT_BULK_CONCURRENCY;
  const concurrency = Math.min(Math.max(1, requestedConcurrency), MAX_BULK_CONCURRENCY);
  if (requestedConcurrency > MAX_BULK_CONCURRENCY) {
    console.warn(`Warning: Concurrency capped at ${MAX_BULK_CONCURRENCY} (requested: ${requestedConcurrency})`);
  }
  const maxCost = options.maxCost ?? DEFAULT_MAX_COST_USD;
  const defaultSize = options.size || DEFAULT_IMAGE_SIZE;

  // Cost estimation for all prompts
  let totalEstimatedCost = 0;
  for (const p of prompts) {
    const estimate = adapter.estimateCost("image", {
      size: p.size || defaultSize,
      count: 1,
      quality: p.quality || options.quality,
    });
    totalEstimatedCost += estimate.max;
  }

  // Dry run - show estimate and exit
  if (options.dryRun) {
    const result = {
      adapter: adapterName,
      promptCount: prompts.length,
      concurrency,
      defaultOptions: {
        size: defaultSize,
        quality: options.quality,
        style: options.style,
      },
      estimatedCost: `$${totalEstimatedCost.toFixed(3)}`,
      maxCost: `$${maxCost.toFixed(2)}`,
      wouldProceed: totalEstimatedCost <= maxCost,
      prompts: prompts.map((p, i) => ({
        index: i,
        prompt: p.prompt.slice(0, 50) + (p.prompt.length > 50 ? "..." : ""),
        size: p.size || defaultSize,
      })),
    };

    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`Adapter: ${adapterName}`);
      console.log(`Prompts: ${prompts.length}`);
      console.log(`Concurrency: ${concurrency}`);
      console.log(`Default size: ${defaultSize}`);
      console.log(`Estimated total cost: $${totalEstimatedCost.toFixed(3)}`);
      console.log(`Max cost: $${maxCost.toFixed(2)}`);
      console.log(
        `Would proceed: ${totalEstimatedCost <= maxCost ? "yes" : "NO (exceeds max)"}`
      );
    }
    return;
  }

  // Cost check
  if (totalEstimatedCost > maxCost) {
    console.error(
      `Error: Estimated cost $${totalEstimatedCost.toFixed(3)} exceeds --max-cost $${maxCost.toFixed(2)}`
    );
    console.error("Use --max-cost to increase limit or --dry-run to preview.");
    process.exit(EXIT_CODES.COST_LIMIT_EXCEEDED);
  }

  // Generate images in parallel with concurrency control
  const results: BulkImageResult[] = await runWithConcurrency(
    prompts,
    async (promptItem, _index) => {
      const genOptions: ImageOptions = {
        size: promptItem.size || defaultSize,
        count: 1,
        quality: promptItem.quality || options.quality,
        style: promptItem.style || options.style,
      };

      try {
        const generated = await generateImage(promptItem.prompt, genOptions);
        const imageData = generated[0]?.data;

        if (!generated.length || !imageData) {
          return {
            prompt: promptItem.prompt,
            success: false,
            error: "No image data returned",
          };
        }

        const result = generated[0];

        // Determine output path
        let outputPath = promptItem.output;
        if (!outputPath && options.output) {
          // If global output is a directory, use it
          outputPath = options.output;
        }

        const path = await saveMedia(
          imageData,
          result.mimeType,
          outputPath,
          "image",
          options.force
        );

        return {
          prompt: promptItem.prompt,
          success: true,
          path,
          revisedPrompt: result.revisedPrompt,
          size: result.width && result.height ? `${result.width}x${result.height}` : undefined,
        };
      } catch (e) {
        return {
          prompt: promptItem.prompt,
          success: false,
          error: e instanceof Error ? e.message : String(e),
        };
      }
    },
    concurrency,
    options.delay ?? DEFAULT_BULK_DELAY_MS
  );

  // Calculate summary
  const successful = results.filter((r) => r.success);
  const failed = results.filter((r) => !r.success);

  // Output results
  if (options.json) {
    console.log(
      JSON.stringify(
        {
          adapter: adapterName,
          summary: {
            total: results.length,
            successful: successful.length,
            failed: failed.length,
          },
          results,
        },
        null,
        2
      )
    );
  } else {
    console.log(`\nBulk image generation complete:`);
    console.log(`  Total: ${results.length}`);
    console.log(`  Successful: ${successful.length}`);
    console.log(`  Failed: ${failed.length}`);
    console.log("");

    const truncate = (s: string, len: number): string =>
      s.length > len ? s.slice(0, len) + "..." : s;

    for (const result of results) {
      if (result.success) {
        console.log(`[OK] ${result.path}`);
        if (result.revisedPrompt && result.revisedPrompt !== result.prompt) {
          console.log(`     Prompt: ${truncate(result.prompt, 40)}`);
          console.log(`     Revised: ${truncate(result.revisedPrompt, 40)}`);
        }
      } else {
        console.log(`[FAIL] ${truncate(result.prompt, 50)}`);
        console.log(`       Error: ${result.error}`);
      }
    }
  }

  // Exit with appropriate code
  if (failed.length === results.length) {
    process.exit(EXIT_CODES.COMPLETE_FAILURE);
  } else if (failed.length > 0) {
    process.exit(EXIT_CODES.PARTIAL_SUCCESS);
  }
}
