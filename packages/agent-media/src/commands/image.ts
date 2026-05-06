/**
 * Image generation command
 */

import { adapterRegistry } from "../adapters/index.js";
import { saveMedia } from "../utils/output.js";
import {
  DEFAULT_IMAGE_SIZE,
  DEFAULT_IMAGE_COUNT,
  DEFAULT_MAX_COST_USD,
  EXIT_CODES,
} from "../config.js";
import type { ImageOptions } from "../adapters/types.js";

export interface ImageCommandOptions {
  adapter?: string;
  size?: string;
  count?: number;
  quality?: "standard" | "hd";
  style?: "natural" | "vivid";
  output?: string;
  dryRun?: boolean;
  maxCost?: number;
  force?: boolean;
  json?: boolean;
}

export async function imageCommand(
  prompt: string,
  options: ImageCommandOptions
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

  const genOptions: ImageOptions = {
    size: options.size || DEFAULT_IMAGE_SIZE,
    count: options.count || DEFAULT_IMAGE_COUNT,
    quality: options.quality,
    style: options.style,
  };

  // Cost estimation
  const estimate = adapter.estimateCost("image", {
    ...genOptions,
    prompt,
  });
  const maxCost = options.maxCost ?? DEFAULT_MAX_COST_USD;

  // Dry run - show estimate and exit
  if (options.dryRun) {
    const result = {
      adapter: adapterName,
      prompt,
      options: genOptions,
      estimatedCost: estimate.breakdown,
      maxCost: `$${maxCost.toFixed(2)}`,
      wouldProceed: estimate.max <= maxCost,
    };

    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`Adapter: ${adapterName}`);
      console.log(`Prompt: ${prompt}`);
      console.log(`Size: ${genOptions.size}`);
      console.log(`Count: ${genOptions.count}`);
      console.log(`Estimated cost: ${estimate.breakdown}`);
      console.log(`Max cost: $${maxCost.toFixed(2)}`);
      console.log(
        `Would proceed: ${estimate.max <= maxCost ? "yes" : "NO (exceeds max)"}`
      );
    }
    return;
  }

  // Cost check
  if (estimate.max > maxCost) {
    console.error(
      `Error: ${estimate.breakdown} exceeds --max-cost $${maxCost.toFixed(2)}`
    );
    console.error("Use --max-cost to increase limit or --dry-run to preview.");
    process.exit(EXIT_CODES.COST_LIMIT_EXCEEDED);
  }

  try {
    // Generate images
    const results = await adapter.generateImage(prompt, genOptions);

    // Save images
    const savedPaths: string[] = [];
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (!result.data) {
        console.error(`Error: No data returned for image ${i + 1}`);
        continue;
      }

      const path = await saveMedia(
        result.data,
        result.mimeType,
        options.output,
        "image",
        options.force
      );
      savedPaths.push(path);
      result.localPath = path;
    }

    // Fail if no images were saved
    if (savedPaths.length === 0) {
      console.error("Error: No images were generated or saved");
      process.exit(EXIT_CODES.COMPLETE_FAILURE);
    }

    // Output results
    if (options.json) {
      console.log(
        JSON.stringify(
          {
            adapter: adapterName,
            prompt,
            count: savedPaths.length,
            files: savedPaths,
            results: results
              .filter((r) => r.localPath)
              .map((r) => ({
                path: r.localPath,
                size: r.width && r.height ? `${r.width}x${r.height}` : "unknown",
                revisedPrompt: r.revisedPrompt,
              })),
          },
          null,
          2
        )
      );
    } else {
      for (const result of results) {
        if (result.localPath) {
          console.log(`Saved: ${result.localPath}`);
          if (result.revisedPrompt && result.revisedPrompt !== prompt) {
            console.log(`  Revised prompt: ${result.revisedPrompt}`);
          }
        }
      }
    }
  } catch (error) {
    if (error instanceof Error) {
      console.error(`Error: ${error.message}`);
    } else {
      console.error("Error generating image");
    }
    process.exit(EXIT_CODES.COMPLETE_FAILURE);
  }
}
