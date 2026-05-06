import { writeFile, mkdir, rename, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname, extname, resolve, relative, isAbsolute } from "node:path";
import { randomBytes } from "node:crypto";
import { getProxyFetch } from "./fetch.js";
import { FILE_MODE, DIR_MODE, VIDEO_TIMEOUT_MS, MAX_RESPONSE_SIZE } from "../config.js";

/**
 * Validate output path doesn't escape working directory
 */
function validateOutputPath(outputPath: string): string {
  const cwd = process.cwd();
  const resolved = resolve(cwd, outputPath);
  const rel = relative(cwd, resolved);

  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`Output path "${outputPath}" escapes working directory`);
  }
  return resolved;
}

/**
 * Generate a timestamped filename
 */
function generateFilename(modality: string, ext: string): string {
  const now = new Date();
  const date = now.toISOString().slice(0, 10).replace(/-/g, "");
  const time = now.toISOString().slice(11, 19).replace(/:/g, "");
  const random = randomBytes(2).toString("hex");
  return `${date}-${time}-${modality}-${random}${ext}`;
}

/**
 * Get file extension from MIME type
 */
function extFromMime(mimeType: string): string {
  const mimeMap: Record<string, string> = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "video/mp4": ".mp4",
    "video/webm": ".webm",
    "audio/mpeg": ".mp3",
    "audio/mp3": ".mp3",
    "audio/wav": ".wav",
    "audio/ogg": ".ogg",
    "audio/flac": ".flac",
    "audio/aac": ".aac",
    "audio/opus": ".opus",
  };
  return mimeMap[mimeType] || ".bin";
}

/**
 * Ensure output directory exists
 */
async function ensureDir(dir: string): Promise<void> {
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true, mode: DIR_MODE });
  }
}

/**
 * Save media data to a file
 *
 * @param data - Binary data to save
 * @param mimeType - MIME type for extension detection
 * @param outputPath - Output path (file or directory)
 * @param modality - Media type for auto-naming
 * @param force - Overwrite existing files
 * @returns Absolute path to saved file
 */
export async function saveMedia(
  data: Buffer,
  mimeType: string,
  outputPath?: string,
  modality: string = "media",
  force: boolean = false
): Promise<string> {
  const ext = extFromMime(mimeType);

  let finalPath: string;

  if (outputPath) {
    // Validate path doesn't escape working directory
    const validatedPath = validateOutputPath(outputPath);

    // Check if outputPath looks like a file (has extension) or directory
    if (extname(validatedPath)) {
      // It's a file path
      finalPath = validatedPath;
      await ensureDir(dirname(validatedPath));
    } else {
      // It's a directory
      await ensureDir(validatedPath);
      finalPath = join(validatedPath, generateFilename(modality, ext));
    }
  } else {
    // Save to current directory with auto-generated name
    finalPath = generateFilename(modality, ext);
  }

  // Check if file exists (unless force is set)
  if (existsSync(finalPath) && !force) {
    throw new Error(
      `File already exists: ${finalPath}. Use --force to overwrite.`
    );
  }

  // Write atomically: temp file -> rename
  const tempPath = `${finalPath}.tmp`;
  try {
    await writeFile(tempPath, data, { mode: FILE_MODE });
    await rename(tempPath, finalPath);
  } catch (error) {
    // Clean up temp file on failure
    try {
      await unlink(tempPath);
    } catch {
      // Ignore cleanup errors
    }
    throw error;
  }

  return finalPath;
}

/**
 * Download media from URL and save to file
 */
export async function downloadAndSave(
  url: string,
  outputPath?: string,
  modality: string = "media",
  force: boolean = false,
  headers?: Record<string, string>
): Promise<string> {
  // Validate URL protocol to prevent SSRF
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid download URL: "${url}"`);
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error(
      `Invalid URL protocol: ${parsed.protocol}. Only http/https allowed.`
    );
  }

  // Use longer timeout for video downloads
  const proxyFetch = getProxyFetch(VIDEO_TIMEOUT_MS);
  const response = await proxyFetch(url, {
    headers: headers || {},
    redirect: "follow",
  });

  if (!response.ok) {
    throw new Error(`Failed to download: ${response.status} ${response.statusText}`);
  }

  // Check Content-Length to prevent OOM from large downloads
  const contentLength = response.headers.get("content-length");
  if (contentLength && parseInt(contentLength, 10) > MAX_RESPONSE_SIZE) {
    throw new Error(
      `Download size ${contentLength} bytes exceeds limit of ${MAX_RESPONSE_SIZE} bytes`
    );
  }

  const contentType = response.headers.get("content-type") || "application/octet-stream";
  const buffer = Buffer.from(await response.arrayBuffer());

  // Verify actual size in case Content-Length was missing or wrong
  if (buffer.length > MAX_RESPONSE_SIZE) {
    throw new Error(
      `Download size ${buffer.length} bytes exceeds limit of ${MAX_RESPONSE_SIZE} bytes`
    );
  }

  return saveMedia(buffer, contentType, outputPath, modality, force);
}

/**
 * Format bytes as human-readable string
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Format duration in seconds as human-readable string
 */
export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
}
