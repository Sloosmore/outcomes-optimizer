/**
 * Exchange a Claude Code refresh token for a fresh access token.
 *
 * Usage:
 *   CLAUDE_CODE_REFRESH_TOKEN=sk-ant-ort01-... npx tsx scripts/refresh-claude-token.ts
 *
 * Outputs: access_token=sk-ant-oat01-... (suitable for >> $GITHUB_OUTPUT)
 *
 * Can also be imported and called programmatically:
 *   import { refreshClaudeToken } from './scripts/refresh-claude-token.js'
 *   const token = await refreshClaudeToken(refreshToken)
 */

const ANTHROPIC_OAUTH_URL = 'https://platform.claude.com/v1/oauth/token'
const CLAUDE_CODE_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'

export async function refreshClaudeToken(refreshToken: string): Promise<string> {
  const res = await fetch(ANTHROPIC_OAUTH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: CLAUDE_CODE_CLIENT_ID,
    }),
  })

  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Token refresh failed (${res.status}): ${body}`)
  }

  const data = (await res.json()) as { access_token?: string; error?: string }
  if (!data.access_token) {
    throw new Error(`Token refresh returned no access_token: ${JSON.stringify(data)}`)
  }

  return data.access_token
}

// CLI entrypoint — outputs in $GITHUB_OUTPUT format
if (import.meta.url === `file://${process.argv[1]}`) {
  const refreshToken = process.env.CLAUDE_CODE_REFRESH_TOKEN
  if (!refreshToken) {
    console.error('Error: CLAUDE_CODE_REFRESH_TOKEN env var is required')
    process.exit(1)
  }

  try {
    const accessToken = await refreshClaudeToken(refreshToken)
    // Write to $GITHUB_OUTPUT if available, otherwise stdout
    const output = `access_token=${accessToken}`
    if (process.env.GITHUB_OUTPUT) {
      const fs = await import('fs')
      fs.appendFileSync(process.env.GITHUB_OUTPUT, output + '\n')
    } else {
      console.log(output)
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  }
}
