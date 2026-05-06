import { describe, it, expect, afterAll } from 'vitest'
import { createMermaidApp, startMermaidServer } from '../mcp-servers/mermaid-http-server.js'
import type { MermaidRenderer } from '../mcp-servers/mermaid-http-server.js'
import { createServer } from 'node:net'
import type { Server as NetServer } from 'node:net'
import type { Server as HttpServer } from 'node:http'

// Mock renderer: returns deterministic SVG based on diagram content
const mockRenderer: MermaidRenderer = async (diagram: string) => {
  return `<svg xmlns="http://www.w3.org/2000/svg" data-diagram="${Buffer.from(diagram).toString('base64')}"><g class="node"/></svg>`
}

const app = createMermaidApp(mockRenderer)

describe('GET /health', () => {
  it('returns {"status":"ok"} with HTTP 200', async () => {
    const res = await app.fetch(new Request('http://localhost:3737/health'))
    expect(res.status).toBe(200)
    const body = await res.json() as { status: string }
    expect(body).toEqual({ status: 'ok' })
  })
})

describe('POST /render', () => {
  it('returns {url, id} with HTTP 200 for a valid diagram', async () => {
    const diagram = 'graph TD\n  A-->B'
    const res = await app.fetch(
      new Request('http://localhost:3737/render', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ diagram }),
      }),
    )
    expect(res.status).toBe(200)
    const body = await res.json() as { url: string; id: string }
    expect(body.id).toBeTruthy()
    expect(body.url).toBe(`http://localhost:3737/view/${body.id}`)
  })
})

describe('GET /view/:id', () => {
  it('returns canvas-wrapped HTML with the SVG embedded (HTTP 200)', async () => {
    const diagram = 'graph LR\n  X-->Y'
    const renderRes = await app.fetch(
      new Request('http://localhost:3737/render', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ diagram }),
      }),
    )
    const { id } = await renderRes.json() as { id: string }

    const viewRes = await app.fetch(new Request(`http://localhost:3737/view/${id}`))
    expect(viewRes.status).toBe(200)
    expect(viewRes.headers.get('content-type')).toMatch(/text\/html/)
    const text = await viewRes.text()
    expect(text).toContain('<!doctype html>')
    expect(text).toContain('class="diagram-wrapper"')
    expect(text).toContain('<svg')
  })

  it('returns HTTP 404 for a nonexistent id', async () => {
    const res = await app.fetch(
      new Request('http://localhost:3737/view/does-not-exist-xyz-99999'),
    )
    expect(res.status).toBe(404)
  })
})

describe('GET /svg/:id', () => {
  it('returns raw SVG bytes with Content-Type: image/svg+xml (HTTP 200)', async () => {
    const diagram = 'graph LR\n  Raw-->Svg'
    const renderRes = await app.fetch(
      new Request('http://localhost:3737/render', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ diagram }),
      }),
    )
    const { id } = await renderRes.json() as { id: string }

    const svgRes = await app.fetch(new Request(`http://localhost:3737/svg/${id}`))
    expect(svgRes.status).toBe(200)
    expect(svgRes.headers.get('content-type')).toMatch(/image\/svg\+xml/)
    const text = await svgRes.text()
    expect(text.startsWith('<svg')).toBe(true)
  })

  it('returns HTTP 404 for a nonexistent id', async () => {
    const res = await app.fetch(
      new Request('http://localhost:3737/svg/does-not-exist'),
    )
    expect(res.status).toBe(404)
  })
})

describe('Idempotency', () => {
  it('POST /render same diagram twice with same id → byte-identical SVG on disk', async () => {
    const diagram = 'graph TD\n  Idempotent-->Check'
    const id = 'idem-test-stable-id'

    // First render
    await app.fetch(
      new Request('http://localhost:3737/render', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ diagram, id }),
      }),
    )
    const firstView = await app.fetch(new Request(`http://localhost:3737/svg/${id}`))
    const firstSvg = await firstView.text()

    // Second render with same diagram + same id
    await app.fetch(
      new Request('http://localhost:3737/render', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ diagram, id }),
      }),
    )
    const secondView = await app.fetch(new Request(`http://localhost:3737/svg/${id}`))
    const secondSvg = await secondView.text()

    expect(firstSvg).toBe(secondSvg)
  })
})

describe('Security', () => {
  it('GET /view/:id strips <script> from embedded SVG', async () => {
    const maliciousSvg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert("xss")</script><g/></svg>'
    const xssApp = createMermaidApp(async () => maliciousSvg)
    const renderRes = await xssApp.fetch(
      new Request('http://localhost:3737/render', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ diagram: 'graph TD\n  A-->B' }),
      }),
    )
    const { id } = await renderRes.json() as { id: string }
    const viewRes = await xssApp.fetch(new Request(`http://localhost:3737/view/${id}`))
    const html = await viewRes.text()
    expect(html).not.toContain('alert("xss")')
    expect(html).toContain('<svg')
  })

  it('GET /view/:id strips javascript: hrefs from embedded SVG', async () => {
    const svgWithJsHref = '<svg xmlns="http://www.w3.org/2000/svg"><a href="javascript:alert(1)"><text>click</text></a></svg>'
    const jsApp = createMermaidApp(async () => svgWithJsHref)
    const renderRes = await jsApp.fetch(
      new Request('http://localhost:3737/render', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ diagram: 'graph TD\n  A-->B' }),
      }),
    )
    const { id } = await renderRes.json() as { id: string }
    const html = await (await jsApp.fetch(new Request(`http://localhost:3737/view/${id}`))).text()
    expect(html).not.toContain('javascript:')
    expect(html).toContain('href="#"')
  })

  it('POST /render rejects id with path traversal characters', async () => {
    const res = await app.fetch(
      new Request('http://localhost:3737/render', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ diagram: 'graph TD\n  A-->B', id: '../../../tmp/evil' }),
      }),
    )
    expect(res.status).toBe(400)
  })

  it('GET /view/:id with path traversal id returns 404', async () => {
    const res = await app.fetch(new Request('http://localhost:3737/view/..%2F..%2Fetc'))
    expect(res.status).toBe(404)
  })

  it('GET /svg/:id with path traversal id returns 404', async () => {
    const res = await app.fetch(new Request('http://localhost:3737/svg/..%2F..%2Fetc'))
    expect(res.status).toBe(404)
  })
})

describe('Port collision handling', () => {
  let occupiedServer: NetServer | null = null
  let startedServer: HttpServer | null = null
  const TEST_PORT = 37370

  afterAll(async () => {
    if (startedServer) {
      await new Promise<void>((resolve) => (startedServer as HttpServer).close(() => resolve()))
    }
    if (occupiedServer) {
      await new Promise<void>((resolve) => (occupiedServer as NetServer).close(() => resolve()))
    }
  })

  it('startMermaidServer on an already-bound port returns {error: "EADDRINUSE", port}', async () => {
    // Bind the port first
    occupiedServer = createServer()
    await new Promise<void>((resolve, reject) => {
      occupiedServer!.once('error', reject)
      occupiedServer!.listen(TEST_PORT, '127.0.0.1', () => resolve())
    })

    // Now try to start the mermaid server on the same port
    const result = await startMermaidServer(TEST_PORT, mockRenderer)

    expect(result).toEqual({ error: 'EADDRINUSE', port: TEST_PORT })

    // result with error has no server to track
    if ('server' in result) {
      startedServer = result.server
    }
  })
})
