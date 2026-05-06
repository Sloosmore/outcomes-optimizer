/**
 * Show adapter capabilities command
 */

import { adapterRegistry } from "../adapters/index.js";
import { EXIT_CODES } from "../config.js";

export interface CapabilitiesCommandOptions {
  json?: boolean;
}

export function capabilitiesCommand(
  adapterName: string,
  options: CapabilitiesCommandOptions
): void {
  if (!adapterRegistry.has(adapterName)) {
    const available = adapterRegistry.list().join(", ");
    console.error(`Unknown adapter: "${adapterName}". Available: ${available}`);
    process.exit(EXIT_CODES.CONFIG_ERROR);
  }

  const adapter = adapterRegistry.get(adapterName);
  const info = adapterRegistry.getInfo(adapterName)!;

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          name: adapterName,
          description: info.description,
          capabilities: adapter.capabilities,
          pricing: adapter.pricing,
          requiresAuth: info.requiresAuth,
          authEnvVars: info.authEnvVars,
          authConfigured: adapterRegistry.checkAuth(adapterName).ok,
        },
        null,
        2
      )
    );
    return;
  }

  console.log(`Adapter: ${adapterName}`);
  console.log(`Description: ${info.description}`);
  console.log();

  const caps = adapter.capabilities;

  if (caps.image) {
    console.log("Image Generation:");
    console.log(`  Sizes: ${caps.image.supportedSizes.join(", ")}`);
    console.log(`  Max count: ${caps.image.maxCount}`);
    if (caps.image.supportsNegativePrompt) {
      console.log(`  Negative prompt: supported`);
    }
    if (adapter.pricing.image) {
      console.log("  Pricing:");
      for (const [size, cost] of Object.entries(adapter.pricing.image.perImage)) {
        console.log(`    ${size}: $${cost.toFixed(2)}/image`);
      }
    }
    console.log();
  }

  if (caps.video) {
    console.log("Video Generation:");
    console.log(`  Max duration: ${caps.video.maxDurationSeconds}s`);
    if (caps.video.supportedAspectRatios) {
      console.log(`  Aspect ratios: ${caps.video.supportedAspectRatios.join(", ")}`);
    }
    if (caps.video.outputExpires) {
      console.log(`  URLs expire: after ${caps.video.expirationHours || 48} hours`);
    }
    if (caps.video.generatesAudio) {
      console.log(`  Audio: generated alongside video (dialogue, sound effects, ambient)`);
      console.log(`    Tip: use quoted dialogue in prompts — e.g. 'says, "Hello!"'`);
    }
    if (adapter.pricing.video) {
      console.log(`  Pricing: $${adapter.pricing.video.perSecond.toFixed(2)}/second`);
    }
    console.log();
  }

  if (caps.audio) {
    console.log("Audio Generation (TTS):");
    console.log(`  Voices: ${caps.audio.voices.join(", ")}`);
    console.log(`  Formats: ${caps.audio.formats.join(", ")}`);
    if (caps.audio.maxLengthCharacters) {
      console.log(`  Max length: ${caps.audio.maxLengthCharacters} characters`);
    }
    if (adapter.pricing.audio) {
      console.log(
        `  Pricing: $${adapter.pricing.audio.perThousandChars.toFixed(4)}/1K characters`
      );
    }
    console.log();
  }

  // Auth status
  const authCheck = adapterRegistry.checkAuth(adapterName);
  if (info.requiresAuth) {
    if (authCheck.ok) {
      console.log("Authentication: configured");
    } else {
      console.log(`Authentication: missing ${authCheck.missing.join(", ")}`);
    }
  } else {
    console.log("Authentication: not required");
  }
}
