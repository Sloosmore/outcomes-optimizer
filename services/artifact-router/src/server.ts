import * as http from 'node:http'
import { createClient } from '@supabase/supabase-js'
import { parseArtifactHost } from '@skill-networks/artifact-url'

const PORT = 8080

const supabaseUrl = process.env['SUPABASE_URL'] ?? ''
const supabaseKey = process.env['SUPABASE_SERVICE_KEY'] ?? ''
if (!supabaseUrl || !supabaseKey) {
  console.log('SUPABASE_URL and SUPABASE_SERVICE_KEY must be set')
  process.exit(1)
}
const supabase = createClient(supabaseUrl, supabaseKey)

async function lookupSandboxIp(sandboxId: string): Promise<string | null> {
  const { data, error } = await supabase
    .from('resources')
    .select('config')
    .eq('id', sandboxId)
    .eq('type', 'server')
    .eq('status', 'active')
    .maybeSingle()

  if (error) {
    console.log('DB error looking up sandbox', sandboxId, error.message)
    return null
  }
  if (!data) return null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- config is jsonb, shape varies
  const cfg = data.config as Record<string, any>
  return typeof cfg?.ip === 'string' ? cfg.ip : null
}

const PROXY_TIMEOUT_MS = 30_000

function proxyRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ip: string,
  port: number,
): void {
  const options: http.RequestOptions = {
    hostname: ip,
    port,
    path: req.url ?? '/',
    method: req.method,
    headers: { ...req.headers, host: `${ip}:${port}` },
    timeout: PROXY_TIMEOUT_MS,
  }

  const upstream = http.request(options, (upRes) => {
    res.writeHead(upRes.statusCode ?? 502, upRes.headers)
    upRes.pipe(res, { end: true })
  })

  upstream.on('error', (err) => {
    console.log(`Proxy error to ${ip}:${port}:`, err.message)
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' })
    }
    res.end(JSON.stringify({ error: 'upstream_unreachable' }))
  })

  upstream.on('timeout', () => {
    upstream.destroy()
    if (!res.headersSent) {
      res.writeHead(504, { 'Content-Type': 'application/json' })
    }
    res.end(JSON.stringify({ error: 'upstream_timeout' }))
  })

  req.on('error', () => upstream.destroy())

  req.pipe(upstream, { end: true })
}

const server = http.createServer(async (req, res) => {
  const host = (req.headers.host ?? '').split(':')[0]

  const parsed = parseArtifactHost(host)
  if (!parsed) {
    res.writeHead(404, { 'Content-Type': 'text/plain' })
    res.end('Not found')
    return
  }

  const { sandboxId, port } = parsed

  const ip = await lookupSandboxIp(sandboxId)
  if (!ip) {
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'sandbox_not_found' }))
    return
  }

  proxyRequest(req, res, ip, port)
})

server.listen(PORT, () => {
  console.log(`artifact-router listening on port ${PORT}`)
})
