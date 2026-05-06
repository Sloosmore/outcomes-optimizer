// ---------------------------------------------------------------------------
// MCP registry — add entries here to give the research agent new capabilities.
// Each entry maps to one MCP server passed to the Claude Code SDK.
//
// In the sandbox sub-agent architecture (Story 5+), MCP servers run INSIDE
// the sandbox (via research.mjs) rather than in the BFF process. This registry
// is retained for future use but is not consumed by the current runtime path.
//
// Servers can be:
//   - stdio:  spawns a child process (dies with the subprocess — beware port lifecycle)
//   - sdk:    in-process (preferred — no ephemeral ports)
// ---------------------------------------------------------------------------

// A minimal type for MCP server configuration. The full type is defined by the
// @modelcontextprotocol/sdk package — we use a structural type here to avoid
// importing the claude-code SDK package in server code.
export type McpServerConfig = Record<string, unknown>

export interface McpEntry {
  /** Key used in mcpServers config (must be unique) */
  name: string
  /** The MCP server config — stdio, sse, http, or sdk */
  config: McpServerConfig
  /** Tool names from this MCP that are auto-allowed */
  allowedTools: string[]
}

export const MCP_REGISTRY: McpEntry[] = []

export function getMcpServersConfig(): Record<string, McpServerConfig> {
  return Object.fromEntries(
    MCP_REGISTRY.map(({ name, config }) => [name, config]),
  )
}

export function getMcpAllowedTools(): string[] {
  return MCP_REGISTRY.flatMap((e) => e.allowedTools)
}
