import { Hono } from 'hono'
import { readFile, stat, mkdir } from 'node:fs/promises'
import { join, basename, extname } from 'node:path'

export const PREVIEW_DIR = '/tmp/research-output'
const MAX_FILE_BYTES = 1_048_576 // 1 MB

// Ensure the output dir exists at import time
await mkdir(PREVIEW_DIR, { recursive: true })

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

/** Binary image extensions served with their native content type */
const BINARY_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
}

// marked 15.0.7 — pin version to avoid silent breaking changes from CDN updates.
// SRI hash omitted; add integrity="sha384-..." once you can compute it from the pinned build.
const HTML_SHELL = (filename: string, raw: string) => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(filename)}</title>
  <script src="https://cdn.jsdelivr.net/npm/marked@15.0.7/marked.min.js" crossorigin="anonymous"></script>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 860px; margin: 0 auto; padding: 2rem; line-height: 1.6; color: #1a1a1a; }
    pre { background: #f5f5f5; padding: 1rem; border-radius: 6px; overflow-x: auto; }
    code { font-family: 'Fira Code', monospace; font-size: 0.9em; }
    h1,h2,h3 { margin-top: 2rem; }
    blockquote { border-left: 4px solid #ccc; margin: 0; padding-left: 1rem; color: #555; }
    table { border-collapse: collapse; width: 100%; }
    th,td { border: 1px solid #ddd; padding: 8px 12px; }
    th { background: #f0f0f0; }
  </style>
</head>
<body>
  <div id="content"></div>
  <script>
    document.getElementById('content').innerHTML = marked.parse(${JSON.stringify(raw)});
  </script>
</body>
</html>`

export const previewRouter = new Hono()

// GET /:filename — serve files from PREVIEW_DIR.
// .html files served as-is; .svg as image/svg+xml; binary images as native
// content type; everything else rendered as markdown.
previewRouter.get('/:filename', async (c) => {
  const raw = c.req.param('filename')
  // Sanitise: strip any path separators so callers can't traverse out of PREVIEW_DIR
  const filename = basename(raw)
  if (!filename || filename.startsWith('.')) {
    return c.text('Not found', 404)
  }
  const filePath = join(PREVIEW_DIR, filename)
  try {
    const info = await stat(filePath)
    if (info.size > MAX_FILE_BYTES) {
      return c.text('File too large for preview', 413)
    }

    const ext = extname(filename).toLowerCase()

    // Binary formats: read as buffer, serve with native content type
    const binaryType = BINARY_TYPES[ext]
    if (binaryType) {
      const buf = await readFile(filePath)
      return new Response(buf, {
        status: 200,
        headers: { 'Content-Type': binaryType, 'Content-Length': buf.byteLength.toString() },
      })
    }

    const content = await readFile(filePath, 'utf8')

    // SVG: serve as image/svg+xml so the browser renders it natively.
    // CSP blocks script execution within the SVG context.
    if (ext === '.svg') {
      return new Response(content, {
        status: 200,
        headers: {
          'Content-Type': 'image/svg+xml',
          'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
        },
      })
    }

    if (filename.endsWith('.html')) {
      return new Response(content, {
        status: 200,
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Security-Policy': "sandbox",
        },
      })
    }
    return new Response(HTML_SHELL(filename, content), {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        // Allow only the pinned CDN script for marked.js; block everything else.
        'Content-Security-Policy': "default-src 'none'; script-src https://cdn.jsdelivr.net; style-src 'unsafe-inline'",
      },
    })
  } catch {
    return c.text(`File not found: ${filename}`, 404)
  }
})
