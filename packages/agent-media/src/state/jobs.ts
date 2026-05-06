/**
 * Video job state management
 *
 * Tracks pending/completed video generation jobs in .agent-media/jobs.json
 */

import { mkdir, readFile, writeFile, rename, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve, relative, isAbsolute } from "node:path";
import { STATE_FILE_MODE, DIR_MODE } from "../config.js";
import type { VideoJob } from "../adapters/types.js";

export interface JobsState {
  jobs: Record<string, VideoJob>;
}

/**
 * Validate state path doesn't escape workspace
 */
function validateStatePath(basePath: string, relativePath: string): string {
  const resolved = resolve(basePath, relativePath);
  const rel = relative(basePath, resolved);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`Invalid stateDir: "${relativePath}" escapes workspace.`);
  }
  return resolved;
}

/**
 * Get the state directory path
 */
export function getStateDir(): string {
  const cwd = process.cwd();

  // Check environment variable first
  if (process.env.AGENT_MEDIA_STATE_DIR) {
    const envPath = process.env.AGENT_MEDIA_STATE_DIR;
    if (!envPath.startsWith("/")) {
      throw new Error(
        `AGENT_MEDIA_STATE_DIR must be absolute, got: "${envPath}"`
      );
    }
    return envPath;
  }

  // Default to workspace-local .agent-media (validated)
  return validateStatePath(cwd, ".agent-media");
}

/**
 * Get the jobs file path
 */
export function getJobsPath(): string {
  return join(getStateDir(), "jobs.json");
}

/**
 * Ensure state directory exists
 */
async function ensureStateDir(): Promise<void> {
  const dir = getStateDir();
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true, mode: DIR_MODE });
  }
}

/**
 * Load jobs state from disk
 */
export async function loadJobs(): Promise<JobsState> {
  const path = getJobsPath();
  if (!existsSync(path)) {
    return { jobs: {} };
  }
  try {
    const content = await readFile(path, "utf-8");
    const parsed = JSON.parse(content);
    return { jobs: parsed.jobs || {} };
  } catch (error) {
    console.warn(`Warning: Failed to load jobs state: ${error}`);
    return { jobs: {} };
  }
}

/**
 * Save jobs state to disk (atomically via temp file + rename)
 */
export async function saveJobs(state: JobsState): Promise<void> {
  await ensureStateDir();
  const path = getJobsPath();
  const tempPath = `${path}.tmp`;
  try {
    await writeFile(tempPath, JSON.stringify(state, null, 2), {
      encoding: "utf-8",
      mode: STATE_FILE_MODE,
    });
    await rename(tempPath, path);
  } catch (error) {
    // Clean up temp file on failure
    try {
      await unlink(tempPath);
    } catch {
      // Ignore cleanup errors
    }
    throw error;
  }
}

/**
 * Add a new job
 */
export async function addJob(job: VideoJob): Promise<void> {
  const state = await loadJobs();
  state.jobs[job.id] = job;
  await saveJobs(state);
}

/**
 * Get a job by ID
 */
export async function getJob(jobId: string): Promise<VideoJob | undefined> {
  const state = await loadJobs();
  return state.jobs[jobId];
}

/**
 * Update a job
 */
export async function updateJob(
  jobId: string,
  update: Partial<VideoJob>
): Promise<void> {
  const state = await loadJobs();
  if (state.jobs[jobId]) {
    state.jobs[jobId] = { ...state.jobs[jobId], ...update };
    await saveJobs(state);
  }
}

/**
 * Remove a job
 */
export async function removeJob(jobId: string): Promise<void> {
  const state = await loadJobs();
  delete state.jobs[jobId];
  await saveJobs(state);
}

/**
 * List all jobs
 */
export async function listJobs(): Promise<VideoJob[]> {
  const state = await loadJobs();
  return Object.values(state.jobs);
}

/**
 * List jobs by status
 */
export async function listJobsByStatus(
  status: VideoJob["status"]
): Promise<VideoJob[]> {
  const jobs = await listJobs();
  return jobs.filter((j) => j.status === status);
}

/**
 * Clean up completed/failed jobs older than given hours
 */
export async function cleanupOldJobs(olderThanHours: number = 24): Promise<number> {
  const state = await loadJobs();
  const cutoff = Date.now() - olderThanHours * 60 * 60 * 1000;
  let removed = 0;

  for (const [id, job] of Object.entries(state.jobs)) {
    if (job.status === "completed" || job.status === "failed") {
      const jobTime = new Date(job.completedAt || job.createdAt).getTime();
      if (jobTime < cutoff) {
        delete state.jobs[id];
        removed++;
      }
    }
  }

  if (removed > 0) {
    await saveJobs(state);
  }

  return removed;
}
