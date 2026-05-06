/**
 * Audio generation command (TTS)
 */

import { adapterRegistry } from "../adapters/index.js";
import { saveMedia } from "../utils/output.js";
import {
  DEFAULT_VOICE,
  DEFAULT_AUDIO_FORMAT,
  DEFAULT_MAX_COST_USD,
  EXIT_CODES,
} from "../config.js";
import type { AudioOptions } from "../adapters/types.js";

export interface AudioCommandOptions {
  adapter?: string;
  voice?: string;
  format?: string;
  speed?: number;
  output?: string;
  dryRun?: boolean;
  maxCost?: number;
  force?: boolean;
  json?: boolean;
}

export async function audioCommand(
  text: string,
  options: AudioCommandOptions
): Promise<void> {
  const adapterName = options.adapter || adapterRegistry.getDefault("audio");

  // Check auth
  const authCheck = adapterRegistry.checkAuth(adapterName);
  if (!authCheck.ok) {
    console.error(
      `Error: Missing environment variable(s): ${authCheck.missing.join(", ")}`
    );
    process.exit(EXIT_CODES.CONFIG_ERROR);
  }

  const adapter = adapterRegistry.get(adapterName);

  // Check adapter supports audio
  if (!adapter.capabilities.modalities.includes("audio")) {
    console.error(
      `Error: Adapter "${adapterName}" does not support audio generation`
    );
    process.exit(EXIT_CODES.CONFIG_ERROR);
  }

  if (!adapter.generateAudio) {
    console.error(
      `Error: Adapter "${adapterName}" does not implement generateAudio`
    );
    process.exit(EXIT_CODES.CONFIG_ERROR);
  }

  const genOptions: AudioOptions = {
    voice: options.voice || DEFAULT_VOICE,
    format: options.format || DEFAULT_AUDIO_FORMAT,
    speed: options.speed,
  };

  // Cost estimation
  const estimate = adapter.estimateCost("audio", {
    ...genOptions,
    text,
  });
  const maxCost = options.maxCost ?? DEFAULT_MAX_COST_USD;

  // Dry run - show estimate and exit
  if (options.dryRun) {
    const result = {
      adapter: adapterName,
      textLength: text.length,
      options: genOptions,
      estimatedCost: estimate.breakdown,
      maxCost: `$${maxCost.toFixed(2)}`,
      wouldProceed: estimate.max <= maxCost,
    };

    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`Adapter: ${adapterName}`);
      console.log(`Text length: ${text.length} characters`);
      console.log(`Voice: ${genOptions.voice}`);
      console.log(`Format: ${genOptions.format}`);
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
    // Generate audio
    const result = await adapter.generateAudio(text, genOptions);

    if (!result.data) {
      console.error("Error: No audio data returned");
      process.exit(EXIT_CODES.COMPLETE_FAILURE);
    }

    // Save audio
    const savedPath = await saveMedia(
      result.data,
      result.mimeType,
      options.output,
      "audio",
      options.force
    );
    result.localPath = savedPath;

    // Output results
    if (options.json) {
      console.log(
        JSON.stringify(
          {
            adapter: adapterName,
            textLength: text.length,
            voice: genOptions.voice,
            format: genOptions.format,
            file: savedPath,
          },
          null,
          2
        )
      );
    } else {
      console.log(`Saved: ${savedPath}`);
    }
  } catch (error) {
    if (error instanceof Error) {
      console.error(`Error: ${error.message}`);
    } else {
      console.error("Error generating audio");
    }
    process.exit(EXIT_CODES.COMPLETE_FAILURE);
  }
}
