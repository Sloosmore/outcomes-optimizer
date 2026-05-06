// Canonical artifact URL utilities — all consumers import from here, never duplicate.

/**
 * Base domain under which artifact subdomains are served, e.g. `example.com`.
 * Resolved from `ARTIFACT_BASE_DOMAIN` (preferred). Defaults to `example.com`
 * so the package compiles without env config; deployments must override.
 *
 * URL pattern: `artifact-<sandboxId>-<port>.<base-domain>`
 * The single-label hostname rides an existing `*.<base-domain>` proxied
 * wildcard so no per-sandbox DNS work is required.
 */
export function getArtifactBaseDomain(): string {
  return process.env.ARTIFACT_BASE_DOMAIN ?? 'example.com'
}

function escapeForRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Matches `artifact-{sandboxId}-{port}.<base-domain>`.
 * Greedy first capture lets sandboxId contain hyphens (UUIDs); the trailing
 * `-\d+` anchors the port at the end.
 */
export function getArtifactHostRegex(): RegExp {
  const domain = escapeForRegex(getArtifactBaseDomain())
  return new RegExp(`^artifact-([a-zA-Z0-9][a-zA-Z0-9-]*)-(\\d+)\\.${domain}$`)
}

/**
 * @deprecated Use `getArtifactHostRegex()` to pick up the configured base
 * domain. This compile-time constant is retained for backwards compatibility
 * and uses the value of `ARTIFACT_BASE_DOMAIN` at module-load time.
 */
export const ARTIFACT_HOST_REGEX = getArtifactHostRegex()

export function buildArtifactUrl(port: number, sandboxId: string): string {
  return `https://artifact-${sandboxId}-${port}.${getArtifactBaseDomain()}/`
}

export function parseArtifactHost(host: string): { sandboxId: string; port: number } | null {
  const m = getArtifactHostRegex().exec(host)
  if (!m) return null
  const port = parseInt(m[2], 10)
  if (port < 1 || port > 65535) return null
  return { port, sandboxId: m[1] }
}
