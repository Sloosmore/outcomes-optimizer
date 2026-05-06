import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { execFile } from 'node:child_process'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import { createServer } from 'node:net'
import type { Server } from 'node:http'
import { createLogger } from '@skill-networks/logger'
import { renderPreviewHtml } from './mermaid-preview-html.js'

const logger = createLogger('mermaid-http-server')

const execFileAsync = promisify(execFile)

/** Where diagrams are stored (matches the in-process mermaid.ts pattern) */
const MERMAID_DATA_DIR = join(homedir(), '.config', 'claude-mermaid', 'live')

export type MermaidRenderer = (diagram: string) => Promise<string>

/** Default renderer: uses mermaid-cli to produce an SVG file; returns the SVG content */
const defaultRenderer: MermaidRenderer = async (diagram: string) => {
  const tempId = randomUUID()
  const tempDir = join(MERMAID_DATA_DIR, tempId)
  await mkdir(tempDir, { recursive: true })

  const inputPath = join(tempDir, 'diagram.mmd')
  const outputPath = join(tempDir, 'diagram.svg')

  await writeFile(inputPath, diagram, 'utf-8')

  await execFileAsync(
    'npx',
    ['-y', '@mermaid-js/mermaid-cli', '-i', inputPath, '-o', outputPath],
    { timeout: 60_000 },
  )

  const svgContent = await readFile(outputPath, 'utf-8')
  return svgContent
}

/** Create the Hono app with an injectable renderer (for testability) */
export function createMermaidApp(renderer: MermaidRenderer = defaultRenderer): Hono {
  const app = new Hono()

  app.get('/health', (c) => {
    return c.json({ status: 'ok' })
  })

  app.post('/render', async (c) => {
    let body: { diagram?: unknown; id?: unknown }
    try {
      body = await c.req.json() as { diagram?: unknown; id?: unknown }
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400)
    }

    if (typeof body.diagram !== 'string' || !body.diagram) {
      return c.json({ error: 'diagram is required and must be a string' }, 400)
    }

    const diagram = body.diagram
    const id = typeof body.id === 'string' && body.id ? body.id : randomUUID()
    const diagramDir = join(MERMAID_DATA_DIR, id)
    if (!diagramDir.startsWith(MERMAID_DATA_DIR + '/')) {
      return c.json({ error: 'Invalid id' }, 400)
    }

    try {
      const svgContent = await renderer(diagram)
      await mkdir(diagramDir, { recursive: true })
      await writeFile(join(diagramDir, 'diagram.svg'), svgContent, 'utf-8')

      logger.info('Diagram rendered', { id })
      return c.json({
        url: `http://localhost:3737/view/${id}`,
        id,
      })
    } catch (err) {
      logger.error('Render failed', { id, error: err instanceof Error ? err.message : String(err) })
      return c.json({ error: 'Render failed' }, 500)
    }
  })

  // Wrapped HTML preview — used by sandbox iframes so the diagram fits the
  // viewport with zoom/pan controls instead of overflowing the page.
  app.get('/view/:id', async (c) => {
    const id = c.req.param('id')
    const svgPath = join(MERMAID_DATA_DIR, id, 'diagram.svg')
    if (!svgPath.startsWith(MERMAID_DATA_DIR + '/')) {
      return c.json({ error: 'Not found' }, 404)
    }

    try {
      const svgContent = await readFile(svgPath, 'utf-8')
      const html = renderPreviewHtml(svgContent, id)
      return new Response(html, {
        status: 200,
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data: blob:; frame-src 'none'; object-src 'none';",
        },
      })
    } catch {
      return c.json({ error: 'Not found' }, 404)
    }
  })

  // Raw SVG bytes — for programmatic consumers that need the SVG directly
  // (e.g. tests, downloads, embeds that supply their own chrome).
  app.get('/svg/:id', async (c) => {
    const id = c.req.param('id')
    const svgPath = join(MERMAID_DATA_DIR, id, 'diagram.svg')
    if (!svgPath.startsWith(MERMAID_DATA_DIR + '/')) {
      return c.json({ error: 'Not found' }, 404)
    }

    try {
      const svgContent = await readFile(svgPath, 'utf-8')
      return new Response(svgContent, {
        status: 200,
        headers: {
          'Content-Type': 'image/svg+xml',
          'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline';",
          'X-Content-Type-Options': 'nosniff',
        },
      })
    } catch {
      return c.json({ error: 'Not found' }, 404)
    }
  })

  return app
}

type StartSuccess = { server: Server; port: number }
type StartError = { error: 'EADDRINUSE'; port: number }

/** Start the Mermaid HTTP server. Returns error object on port collision, never throws. */
export async function startMermaidServer(
  port: number,
  renderer?: MermaidRenderer,
): Promise<StartSuccess | StartError> {
  // Pre-check: probe the port with a throwaway net.Server to get a clean EADDRINUSE
  // before we hand it to @hono/node-server (which doesn't surface the error code cleanly)
  const probe = createServer()
  const probeResult = await new Promise<null | 'EADDRINUSE'>((resolve) => {
    probe.once('error', (err: NodeJS.ErrnoException) => {
      resolve(err.code === 'EADDRINUSE' ? 'EADDRINUSE' : null)
    })
    probe.listen(port, '127.0.0.1', () => {
      probe.close(() => resolve(null))
    })
  })

  if (probeResult === 'EADDRINUSE') {
    return { error: 'EADDRINUSE', port }
  }

  const app = createMermaidApp(renderer)

  return new Promise<StartSuccess | StartError>((resolve) => {
    const server = serve({ fetch: app.fetch, port }, () => {
      logger.info('Mermaid HTTP server started', { port })
      resolve({ server: server as unknown as Server, port })
    })

    ;(server as unknown as { on: (event: string, cb: (err: NodeJS.ErrnoException) => void) => void })
      .on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          resolve({ error: 'EADDRINUSE', port })
        } else {
          logger.error('Server error', { error: err.message })
          resolve({ error: 'EADDRINUSE', port })
        }
      })
  })
}
