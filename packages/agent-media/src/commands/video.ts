/**
 * Video generation command
 *
 * Video generation is async - start job, poll for completion.
 * Designed to work with Claude Code background agents.
 */

import { existsSync } from "node:fs";
import { adapterRegistry } from "../adapters/index.js";
import { downloadAndSave } from "../utils/output.js";
import {
  DEFAULT_VIDEO_DURATION_S,
  DEFAULT_MAX_COST_USD,
  EXIT_CODES,
} from "../config.js";
import type { VideoOptions } from "../adapters/types.js";
import { addJob, getJob, updateJob, listJobs } from "../state/jobs.js";
import { getGoogleApiKey } from "../utils/auth.js";

export interface VideoCommandOptions {
  adapter?: string;
  duration?: number;
  aspectRatio?: string;
  output?: string;
  dryRun?: boolean;
  maxCost?: number;
  firstFrame?: string;
  // Async operation flags
  start?: boolean;
  check?: string;
  download?: string;
  // List jobs
  jobs?: boolean;
  json?: boolean;
}

export async function videoCommand(
  prompt: string | undefined,
  options: VideoCommandOptions
): Promise<void> {
  // List jobs mode
  if (options.jobs) {
    await listJobsCommand(options);
    return;
  }

  // Check job status mode
  if (options.check) {
    await checkJobCommand(options.check, options);
    return;
  }

  // Download completed video mode
  if (options.download) {
    await downloadJobCommand(options.download, options);
    return;
  }

  // Start or full generation mode - prompt required
  if (!prompt) {
    console.error("Error: Prompt is required for video generation");
    process.exit(EXIT_CODES.CONFIG_ERROR);
  }

  const adapterName = options.adapter || adapterRegistry.getDefault("video");

  // Check auth
  const authCheck = adapterRegistry.checkAuth(adapterName);
  if (!authCheck.ok) {
    console.error(
      `Error: Missing environment variable(s): ${authCheck.missing.join(", ")}`
    );
    process.exit(EXIT_CODES.CONFIG_ERROR);
  }

  const adapter = adapterRegistry.get(adapterName);

  // Check adapter supports video
  if (!adapter.capabilities.modalities.includes("video")) {
    console.error(
      `Error: Adapter "${adapterName}" does not support video generation`
    );
    process.exit(EXIT_CODES.CONFIG_ERROR);
  }

  if (!adapter.startVideo) {
    console.error(
      `Error: Adapter "${adapterName}" does not implement startVideo`
    );
    process.exit(EXIT_CODES.CONFIG_ERROR);
  }

  const genOptions: VideoOptions = {
    duration: options.duration || DEFAULT_VIDEO_DURATION_S,
    aspectRatio: options.aspectRatio,
  };

  if (options.firstFrame) {
    const { readFile } = await import("node:fs/promises");
    genOptions.firstFrame = await readFile(options.firstFrame);
  }

  // Cost estimation
  const estimate = adapter.estimateCost("video", {
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
      estimatedTime: "1-5 minutes",
      maxCost: `$${maxCost.toFixed(2)}`,
      wouldProceed: estimate.max <= maxCost,
      warning: "Video URLs expire after 48 hours - download promptly!",
    };

    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`Adapter: ${adapterName}`);
      console.log(`Prompt: ${prompt}`);
      console.log(`Duration: ${genOptions.duration}s`);
      console.log(`Estimated cost: ${estimate.breakdown}`);
      console.log(`Estimated time: 1-5 minutes`);
      console.log(`Max cost: $${maxCost.toFixed(2)}`);
      console.log(
        `Would proceed: ${estimate.max <= maxCost ? "yes" : "NO (exceeds max)"}`
      );
      console.log(`\nWarning: Video URLs expire after 48 hours!`);
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
    // Start generation
    const job = await adapter.startVideo(prompt, genOptions);
    await addJob(job);

    if (options.json) {
      console.log(
        JSON.stringify(
          {
            jobId: job.id,
            status: job.status,
            prompt,
            adapter: adapterName,
            estimatedTime: "1-5 minutes",
            checkCommand: `agent-media video --check ${job.id}`,
            downloadCommand: `agent-media video --download ${job.id} --output video.mp4`,
          },
          null,
          2
        )
      );
    } else {
      console.log(`Started video generation: ${job.id}`);
      console.log(`Prompt: ${prompt}`);
      console.log(`Estimated time: 1-5 minutes`);
      console.log(`\nTo check status:`);
      console.log(`  agent-media video --check ${job.id}`);
      console.log(`\nTo download when ready:`);
      console.log(`  agent-media video --download ${job.id} --output video.mp4`);
      console.log(`\nWarning: Video URLs expire after 48 hours!`);
    }
  } catch (error) {
    if (error instanceof Error) {
      console.error(`Error: ${error.message}`);
    } else {
      console.error("Error starting video generation");
    }
    process.exit(EXIT_CODES.COMPLETE_FAILURE);
  }
}

/**
 * List all video jobs
 */
async function listJobsCommand(options: VideoCommandOptions): Promise<void> {
  const jobs = await listJobs();

  if (jobs.length === 0) {
    if (options.json) {
      console.log(JSON.stringify({ jobs: [] }, null, 2));
    } else {
      console.log("No video jobs found.");
    }
    return;
  }

  if (options.json) {
    console.log(JSON.stringify({ jobs }, null, 2));
  } else {
    for (const job of jobs) {
      const age = getAge(job.createdAt);
      console.log(`${job.id}: ${job.status} (${age})`);
      console.log(`  Prompt: ${job.prompt.slice(0, 50)}${job.prompt.length > 50 ? "..." : ""}`);
      if (job.result?.localPath) {
        console.log(`  File: ${job.result.localPath}`);
      }
      if (job.error) {
        console.log(`  Error: ${job.error}`);
      }
      console.log();
    }
  }
}

/**
 * Check status of a specific job
 */
async function checkJobCommand(
  jobId: string,
  options: VideoCommandOptions
): Promise<void> {
  // First check local state
  let job = await getJob(jobId);

  if (!job) {
    console.error(`Error: Job not found: ${jobId}`);
    process.exit(EXIT_CODES.CONFIG_ERROR);
  }

  // If still pending/processing, poll the API
  if (job.status === "pending" || job.status === "processing") {
    const adapter = adapterRegistry.get(job.adapter);
    if (adapter.pollVideo) {
      try {
        const updated = await adapter.pollVideo(jobId);
        // Merge with existing job data, preserving original metadata
        job = { ...job, ...updated, prompt: job.prompt, createdAt: job.createdAt };
      } catch (error) {
        // If poll fails, show cached state and exit with error
        if (options.json) {
          console.log(JSON.stringify({ ...job, pollError: String(error) }, null, 2));
        } else {
          console.log(`Status: ${job.status}`);
          console.log(`Poll error: ${error}`);
        }
        process.exit(EXIT_CODES.PARTIAL_SUCCESS);
      }
      // Persist state update separately
      try {
        await updateJob(jobId, job);
      } catch (error) {
        console.error(`Warning: Failed to persist job state: ${error}`);
      }
    }
  }

  if (options.json) {
    console.log(JSON.stringify(job, null, 2));
  } else {
    console.log(`Job: ${job.id}`);
    console.log(`Status: ${job.status}`);
    console.log(`Prompt: ${job.prompt}`);
    console.log(`Created: ${job.createdAt}`);
    if (job.completedAt) {
      console.log(`Completed: ${job.completedAt}`);
    }
    if (job.result?.url) {
      console.log(`URL: ${job.result.url}`);
      if (job.result.expiresAt) {
        console.log(`Expires: ${job.result.expiresAt}`);
      }
    }
    if (job.result?.localPath) {
      console.log(`File: ${job.result.localPath}`);
    }
    if (job.error) {
      console.log(`Error: ${job.error}`);
    }
  }
}

/**
 * Download a completed video
 */
async function downloadJobCommand(
  jobId: string,
  options: VideoCommandOptions
): Promise<void> {
  let job = await getJob(jobId);

  if (!job) {
    console.error(`Error: Job not found: ${jobId}`);
    process.exit(EXIT_CODES.CONFIG_ERROR);
  }

  // If not completed, try polling first
  if (job.status !== "completed") {
    const adapter = adapterRegistry.get(job.adapter);
    if (adapter.pollVideo) {
      try {
        const updated = await adapter.pollVideo(jobId);
        // Preserve original metadata that poll doesn't return
        job = { ...job, ...updated, prompt: job.prompt, createdAt: job.createdAt };
      } catch (error) {
        console.error(`Error polling job: ${error}`);
      }
      // Persist state update separately
      try {
        await updateJob(jobId, job);
      } catch (error) {
        console.error(`Warning: Failed to persist job state: ${error}`);
      }
    }
  }

  if (job.status !== "completed") {
    console.error(`Error: Job not completed. Status: ${job.status}`);
    if (job.status === "failed") {
      console.error(`Error: ${job.error}`);
    }
    process.exit(EXIT_CODES.COMPLETE_FAILURE);
  }

  if (!job.result?.url) {
    console.error("Error: No video URL available");
    process.exit(EXIT_CODES.COMPLETE_FAILURE);
  }

  // Check if already downloaded and file still exists
  if (job.result.localPath && existsSync(job.result.localPath)) {
    if (options.json) {
      console.log(JSON.stringify({ file: job.result.localPath, cached: true }, null, 2));
    } else {
      console.log(`Already downloaded: ${job.result.localPath}`);
    }
    return;
  }

  try {
    // For Google/Veo videos, we need to pass the API key for download
    const downloadHeaders: Record<string, string> = {};
    if (job.adapter === "google") {
      try {
        const apiKey = getGoogleApiKey();
        downloadHeaders["x-goog-api-key"] = apiKey;
      } catch {
        // If no API key available, try without (might work for some URLs)
      }
    }

    const savedPath = await downloadAndSave(
      job.result.url,
      options.output,
      "video",
      true, // Allow overwriting for video downloads
      downloadHeaders
    );

    // Update job with local path
    job.result.localPath = savedPath;
    await updateJob(jobId, job);

    if (options.json) {
      console.log(JSON.stringify({ file: savedPath }, null, 2));
    } else {
      console.log(`Downloaded: ${savedPath}`);
    }
  } catch (error) {
    if (error instanceof Error) {
      console.error(`Error downloading: ${error.message}`);
    } else {
      console.error("Error downloading video");
    }
    process.exit(EXIT_CODES.COMPLETE_FAILURE);
  }
}

/**
 * Get human-readable age string
 */
function getAge(isoDate: string): string {
  const date = new Date(isoDate);
  if (isNaN(date.getTime())) {
    return "unknown";
  }
  const ms = Date.now() - date.getTime();
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
