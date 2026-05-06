/**
 * CLI for uploading assets to public Supabase bucket
 *
 * Usage:
 *   npm run upload-asset <file-path> [folder]
 *   npm run upload-asset ./image.png slide-assets
 *
 * Returns JSON with { url, path, fileName }
 */
import 'dotenv/config'
import { uploadPublicAsset, isStorageEnabled } from './traces.js'

async function main() {
  const [filePath, folder = 'assets'] = process.argv.slice(2)

  if (!filePath || filePath.startsWith('-')) {
    console.log(`
Upload Asset CLI

Usage:
  npm run upload-asset <file-path> [folder]

Arguments:
  file-path   Path to the file to upload
  folder      Folder in the bucket (default: "assets")

Example:
  npm run upload-asset ./image.png slide-assets

Output:
  JSON with { url, path, fileName }
`)
    process.exit(filePath ? 1 : 0)
  }

  if (!isStorageEnabled()) {
    console.error('Error: SUPABASE_URL and SUPABASE_SERVICE_KEY must be set')
    process.exit(1)
  }

  const result = await uploadPublicAsset(filePath, folder)

  if (!result) {
    console.error('Upload failed')
    process.exit(1)
  }

  // Output JSON for easy parsing by agents
  console.log(JSON.stringify(result, null, 2))
}

main().catch((err) => {
  console.error('Fatal error:', err instanceof Error ? err.message : err)
  process.exit(1)
})
