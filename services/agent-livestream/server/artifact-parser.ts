import { createLogger } from '@skill-networks/logger'
import { buildArtifactUrl } from '../shared/artifact-url.js'

const logger = createLogger('agent-livestream:artifact-parser')

export interface ArtifactTag {
  port: number
  label: string
  path?: string
  directUrl?: string
}

/**
 * Build the artifact URL for a port (and optional path) using the canonical
 * artifact-router format: `https://artifact-<sandboxId>-<port>.example.com/<path>`.
 *
 * SANDBOX_ID must be set in the process env. If it is not (e.g. local dev with
 * no sandbox attached), we fall back to `http://localhost:<port>/` so the
 * developer can still iterate. There are no env-var fallbacks for tunnel
 * domains or legacy host overrides — the artifact-router single-label hostname is
 * the only production path.
 */
function buildSandboxArtifactUrl(port: number, path?: string): string {
  const pathSuffix = path ?? ''
  const sandboxId = process.env['SANDBOX_ID']
  if (sandboxId) {
    // buildArtifactUrl returns trailing-slash form, so append path directly.
    return buildArtifactUrl(port, sandboxId) + pathSuffix
  }
  // Production must always have SANDBOX_ID. Browsers cannot reach a
  // localhost URL emitted from a Vercel-hosted BFF; warn loudly so the
  // misconfiguration surfaces in logs instead of silently returning broken
  // artifact URLs.
  if (process.env['NODE_ENV'] === 'production') {
    logger.warn('SANDBOX_ID unset in production — artifact URL will fall back to localhost', { port })
  }
  return `http://localhost:${port}/${pathSuffix}`
}

/**
 * Single canonical resolver for an ArtifactTag → URL.
 *
 * All call sites (chat-stream SSE, /api/tools route, voice path) MUST use
 * this helper. Keeping resolution logic here ensures a localhost directUrl
 * is always upgraded to the artifact-router form so the browser can reach
 * the artifact via the external tunnel.
 */
export function resolveArtifactUrl(tag: ArtifactTag): string {
  const direct = tag.directUrl
  // Upgrade localhost direct URLs to the tunnelled form.
  if (direct && direct.startsWith('http://localhost:') && tag.port > 0) {
    try {
      const path = new URL(direct).pathname.slice(1) // strip leading /
      return buildSandboxArtifactUrl(tag.port, path || undefined)
    } catch {
      // Malformed URL — fall through to plain direct resolution.
    }
  }
  return direct ?? buildSandboxArtifactUrl(tag.port, tag.path)
}

/**
 * Parses an <open_artifact> tag from text.
 * Accepts attributes in any order, self-closing or open tags.
 *
 * Supports two forms:
 *   <open_artifact url="http://localhost:3740/view/foo" />   — uses url directly
 *   <open_artifact port="3737" label="Diagram" />             — builds url from port
 *
 * Label falls back to `type` attribute, then "Artifact".
 */
export function parseArtifactTag(text: string): ArtifactTag | null {
  const tagMatch = text.match(/<open_artifact\b([^>]*?)\/?>/)
  if (!tagMatch) return null
  const attrs = tagMatch[1] ?? ''

  const label =
    attrs.match(/\blabel="([^"]+)"/)?.[1] ??
    attrs.match(/\btype="([^"]+)"/)?.[1] ??
    'Artifact'

  // Form 1: direct URL provided — extract port from URL
  const directUrl = attrs.match(/\burl="([^"]+)"/)?.[1]
  if (directUrl) {
    // data: URIs have no port — treat as port 0 (caller checks artifact.url, not artifact.port)
    if (directUrl.startsWith('data:')) {
      return { port: 0, label, directUrl }
    }
    try {
      const { port: urlPort } = new URL(directUrl)
      const port = parseInt(urlPort, 10)
      if (Number.isInteger(port) && port >= 1 && port <= 65535) {
        return { port, label, directUrl }
      }
      // Valid URL but no explicit port (e.g. https://mermaid.example.com/...) — use port 0.
      // tools.ts uses directUrl directly when port is 0 and url is not localhost.
      return { port: 0, label, directUrl }
    } catch {
      // Malformed URL — fall through to port-based form
    }
  }

  // Form 2: explicit port attribute
  const portStr = attrs.match(/\bport="(\d+)"/)?.[1]
  if (!portStr) return null
  const port = parseInt(portStr, 10)
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null
  const path = attrs.match(/\bpath="([^"]*)"/)?.[1]
  return { port, label, ...(path !== undefined ? { path } : {}) }
}
