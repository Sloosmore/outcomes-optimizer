import { createClient, SupabaseClient } from '@supabase/supabase-js'
import * as fs from 'fs'
import * as path from 'path'
import { getSupabaseServiceKey, getSupabaseUrl } from '../constants.js'

const BUCKET_NAME = 'traces'
const PUBLIC_ASSETS_BUCKET = 'public-assets'

let _client: SupabaseClient | undefined

function getStorageClient(): SupabaseClient | null {
  if (_client) return _client

  const url = getSupabaseUrl()
  // Storage is optional — getSupabaseServiceKey() throws when unset, so we catch
  // and return null to keep the existing "disabled when env is missing" behavior.
  let key: string
  try {
    key = getSupabaseServiceKey()
  } catch {
    return null
  }

  _client = createClient(url, key)
  return _client
}

export function isStorageEnabled(): boolean {
  try {
    getSupabaseServiceKey()
    return true
  } catch {
    return false
  }
}

/**
 * Upload a trace file to Supabase Storage
 * Returns the storage path on success, null on failure
 */
export async function uploadTrace(sessionId: string, content: string): Promise<string | null> {
  const client = getStorageClient()
  if (!client) return null

  const storagePath = `${sessionId}.jsonl`

  const { error } = await client.storage
    .from(BUCKET_NAME)
    .upload(storagePath, content, {
      contentType: 'application/jsonl',
      upsert: true,
    })

  if (error) {
    console.error(`[storage] Upload failed: ${error.message}`)
    return null
  }

  return storagePath
}

/**
 * Download a trace file from Supabase Storage
 * Returns the content on success, null on failure
 */
export async function downloadTrace(sessionId: string): Promise<string | null> {
  const client = getStorageClient()
  if (!client) return null

  const filePath = `${sessionId}.jsonl`

  const { data, error } = await client.storage
    .from(BUCKET_NAME)
    .download(filePath)

  if (error) {
    // Don't log "not found" errors as they're expected for local-only traces
    if (!error.message.includes('not found')) {
      console.error(`[storage] Download failed: ${error.message}`)
    }
    return null
  }

  return await data.text()
}

// ============================================================================
// Public Assets - for hosting images/files with public URLs
// ============================================================================

/**
 * Get the public URL for a file in the public-assets bucket
 */
export function getPublicAssetUrl(filePath: string): string {
  const supabaseUrl = getSupabaseUrl()
  return `${supabaseUrl}/storage/v1/object/public/${PUBLIC_ASSETS_BUCKET}/${filePath}`
}

/**
 * Upload a file to the public-assets bucket
 * Returns { url, path } on success
 */
export async function uploadPublicAsset(
  localPath: string,
  folder: string = 'assets'
): Promise<{ url: string; path: string; fileName: string } | null> {
  const client = getStorageClient()
  if (!client) return null

  const fileName = path.basename(localPath)
  const ext = path.extname(localPath).toLowerCase()
  const timestamp = Date.now()
  const storagePath = `${folder}/${timestamp}-${fileName}`

  // Determine content type
  const contentTypes: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.webp': 'image/webp',
    '.pdf': 'application/pdf',
    '.zip': 'application/zip',
    '.mp4': 'video/mp4',
    '.mov': 'video/quicktime',
    '.webm': 'video/webm',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
  }
  const contentType = contentTypes[ext] || 'application/octet-stream'

  const fileContent = fs.readFileSync(localPath)

  const { error } = await client.storage
    .from(PUBLIC_ASSETS_BUCKET)
    .upload(storagePath, fileContent, {
      contentType,
      upsert: true,
    })

  if (error) {
    console.error(`[storage] Public asset upload failed: ${error.message}`)
    return null
  }

  const url = getPublicAssetUrl(storagePath)
  return { url, path: storagePath, fileName }
}

/**
 * Upload a buffer directly to the public-assets bucket
 * Returns { url, path } on success
 */
export async function uploadPublicAssetBuffer(
  buffer: Buffer,
  fileName: string,
  folder: string = 'assets',
  contentType: string = 'application/octet-stream'
): Promise<{ url: string; path: string; fileName: string } | null> {
  const client = getStorageClient()
  if (!client) return null

  const timestamp = Date.now()
  const storagePath = `${folder}/${timestamp}-${fileName}`

  const { error } = await client.storage
    .from(PUBLIC_ASSETS_BUCKET)
    .upload(storagePath, buffer, {
      contentType,
      upsert: true,
    })

  if (error) {
    console.error(`[storage] Public asset upload failed: ${error.message}`)
    return null
  }

  const url = getPublicAssetUrl(storagePath)
  return { url, path: storagePath, fileName }
}

/** For testing: reset the cached Supabase client so tests can re-initialise with different env vars. */
export function _resetStorageClientForTesting(): void {
  _client = undefined
}

/**
 * List files in a folder in the public-assets bucket
 */
export async function listPublicAssets(folder: string): Promise<string[] | null> {
  const client = getStorageClient()
  if (!client) return null

  const { data, error } = await client.storage
    .from(PUBLIC_ASSETS_BUCKET)
    .list(folder)

  if (error) {
    console.error(`[storage] List failed: ${error.message}`)
    return null
  }

  return data.map(f => `${folder}/${f.name}`)
}
