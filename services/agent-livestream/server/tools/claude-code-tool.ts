import type { JobContext } from '../adapters/realtime/livekit-agents.js'
import { RESEARCH } from '../constants.js'
import { runSandboxAgent } from '../adapters/research/sandbox-agent-runner.js'
import { createLogger } from '@skill-networks/logger'

const logger = createLogger('agent-livestream:claude-code')

const CLAUDE_CODE_DEDUP_MS = 900_000 // 15 min — suppresses identical-prompt repeats
const recentCalls = new Map<string, number>()

interface SandboxAgentCtx {
  host: string
  sandboxId: string
  privateKey: string
}

async function resolveSandboxCtx(
  voiceToolJwt: string,
  BFF_URL: string,
): Promise<SandboxAgentCtx | null> {
  try {
    const res = await fetch(`${BFF_URL}/api/voice-tool/ctx`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${voiceToolJwt}`,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '<unreadable>')
      const jwtPreview = voiceToolJwt.length > 32
        ? `${voiceToolJwt.slice(0, 16)}...${voiceToolJwt.slice(-8)}`
        : '<short>'
      logger.warn('voice-tool/ctx returned non-OK', {
        status: res.status,
        body: body.slice(0, 200),
        jwtPreview,
        BFF_URL,
      })
      return null
    }
    return await res.json() as SandboxAgentCtx
  } catch (err) {
    logger.warn('voice-tool/ctx fetch threw', {
      err: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}

interface ClaudeCodeToolOptions {
  voiceToolJwt: string | undefined
  BFF_URL: string
  prompt: string
  ctx: JobContext
}

/**
 * Result handed back to the LLM as the canonical tool_result.
 * `replyText` is what the LLM sees as the tool's return value — it should
 * contain the artifact URL when one exists so the LLM can summarize without
 * speculating or re-firing share_screen.
 */
export interface ClaudeCodeToolResult {
  artifactUrl: string | null
  replyText: string
}

/**
 * Extract the first canonical artifact URL from research result text.
 * Pattern: https://artifact-<sandboxId>-<port>.example.com/<path>
 * Anchors on the artifact-<uuid>-<port> form so we don't match share-screen
 * URLs the model invented (e.g. https://artifact-sandbox-3000.example.com).
 */
function extractArtifactUrl(text: string): string | null {
  // sandboxId is a UUID (8-4-4-4-12 hex chars). Anything else is hallucinated.
  const re = /(https:\/\/artifact-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-\d+\.duoidal\.com[^\s)\\"'<>]*)/i
  const m = text.match(re)
  if (!m) return null
  // Trim trailing sentence punctuation. LLMs end sentences like "…at <URL>." and
  // the URL char-class above isn't strict enough to exclude that tail period —
  // leaving it on causes the iframe src to 404 on a non-existent path.
  return m[1].replace(/[.,;:!?]+$/, '')
}

export async function executeClaudeCodeTool({
  voiceToolJwt,
  BFF_URL,
  prompt,
  ctx,
}: ClaudeCodeToolOptions): Promise<ClaudeCodeToolResult> {
  if (prompt.length > 10_000) {
    return { artifactUrl: null, replyText: 'claude_code prompt too long (max 10 000 chars).' }
  }
  const now = Date.now()
  // Evict entries older than the dedup window to bound map growth in long-running workers.
  for (const [k, ts] of recentCalls) {
    if (now - ts > CLAUDE_CODE_DEDUP_MS) recentCalls.delete(k)
  }
  // Include a JWT suffix so two users sending the same prompt don't block each other.
  // The last 16 chars of the JWT are non-sensitive (part of the signature) and stable per-session.
  const jwtSuffix = voiceToolJwt ? voiceToolJwt.slice(-16) : 'anon'
  const key = `${jwtSuffix}:${prompt.trim().toLowerCase().slice(0, 100)}`
  const lastCall = recentCalls.get(key)
  if (lastCall && now - lastCall < CLAUDE_CODE_DEDUP_MS) {
    return { artifactUrl: null, replyText: 'Already running claude_code on this exact prompt. Skipping duplicate.' }
  }
  recentCalls.set(key, now)

  const startedAt = Date.now()
  logger.info('claude_code tool called', {
    promptPreview: prompt.substring(0, 200),
    promptLength: prompt.length,
    hasJwt: !!voiceToolJwt,
    BFF_URL,
    timeoutMs: RESEARCH.ADAPTER_TIMEOUT_MS,
  })
  try {
    logger.info('phase', { phase: 'sandbox_provision_started', t_ms: performance.now() })
    logger.info('resolving sandbox ctx via BFF')
    const sandboxCtx = voiceToolJwt ? await resolveSandboxCtx(voiceToolJwt, BFF_URL) : null
    logger.info('phase', { phase: 'sandbox_ready', t_ms: performance.now(), ok: !!sandboxCtx })
    logger.info('sandbox ctx resolved', {
      ok: !!sandboxCtx,
      host: sandboxCtx?.host,
      sandboxId: sandboxCtx?.sandboxId,
      elapsedMs: Date.now() - startedAt,
    })
    if (!sandboxCtx) {
      // No sandbox is a recoverable provisioning state — release the dedup
      // lock so the user can retry once the sandbox comes up.
      recentCalls.delete(key)
      return { artifactUrl: null, replyText: 'claude_code failed: no sandbox available for this user.' }
    }

    logger.info('starting runSandboxAgent', { host: sandboxCtx.host, sandboxId: sandboxCtx.sandboxId })
    logger.info('phase', { phase: 'subagent_started', t_ms: performance.now(), sandboxId: sandboxCtx.sandboxId })
    const sandboxStart = Date.now()
    let result: { text: string }
    try {
      result = await runSandboxAgent(prompt, {
        host: sandboxCtx.host,
        privateKey: sandboxCtx.privateKey,
        sandboxId: sandboxCtx.sandboxId,
        timeoutMs: RESEARCH.ADAPTER_TIMEOUT_MS,
      })
    } catch (sbErr) {
      const e = sbErr as Error & { cause?: unknown }
      logger.error('runSandboxAgent.failed', {
        durationMs: Date.now() - sandboxStart,
        message: e?.message,
        name: e?.name,
        stack: e?.stack,
        cause: e?.cause,
      })
      throw sbErr
    }

    logger.info('claude_code complete', {
      durationMs: Date.now() - sandboxStart,
      textLength: result.text.length,
      preview: result.text.substring(0, 200),
    })

    // If the SDK rendered an artifact, route the canonical URL straight to
    // the iframe via the artifact_ready data channel. Bypasses share_screen
    // entirely — the voice LLM was unreliable at preserving long URLs and
    // sometimes hallucinated wrong ones (or fired share_screen speculatively
    // before research returned). The frontend deduplicates by URL+nonce.
    const artifactUrl = extractArtifactUrl(result.text)
    if (artifactUrl && ctx.agent) {
      logger.info('phase', { phase: 'subagent_artifact_ready', t_ms: performance.now(), artifactUrl })
      logger.info('auto-firing artifact_ready for canonical URL', { artifactUrl, hasAgent: true })
      ctx.agent.sendText(
        JSON.stringify({ url: artifactUrl, port: 0, summary: '', nonce: Date.now() }),
        { topic: 'artifact_ready' },
      ).catch((sendErr: unknown) => {
        logger.error('artifact_ready sendText failed', {
          artifactUrl,
          err: sendErr instanceof Error ? sendErr.message : String(sendErr),
        })
      })
    } else {
      logger.warn('artifact_ready not emitted', {
        hasArtifactUrl: !!artifactUrl,
        hasAgent: !!ctx.agent,
        textPreview: result.text.slice(0, 200),
      })
    }

    // Build the tool_result text the LLM will see. When an artifact was
    // displayed, the URL appears byte-for-byte first so the LLM can quote it
    // for share_screen if asked, followed by the description for natural
    // conversational summary. The artifact_ready data channel has already
    // mounted the iframe, so no share_screen call is needed for this URL.
    const replyText = artifactUrl
      ? `Artifact ready at ${artifactUrl}. ${result.text}`
      : result.text

    logger.info('claude_code returning result', {
      artifactUrl,
      replyTextLength: replyText.length,
      totalDurationMs: Date.now() - startedAt,
    })
    return { artifactUrl, replyText }
  } catch (err) {
    const e = err as Error & { cause?: unknown }
    logger.error('claude_code outer catch', {
      message: e?.message,
      name: e?.name,
      stack: e?.stack,
      cause: e?.cause,
      totalDurationMs: Date.now() - startedAt,
    })
    // Release the dedup lock on failure so the user can retry immediately.
    // Without this, a single SSH timeout or sandbox error locks the same
    // prompt for the full CLAUDE_CODE_DEDUP_MS window and the user has no
    // recovery path. The dedup is meant to suppress accidental duplicate
    // tool_calls in flight, not punish the user for a transient backend
    // failure.
    recentCalls.delete(key)
    return {
      artifactUrl: null,
      replyText: `claude_code failed: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}
