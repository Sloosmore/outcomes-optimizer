/**
 * Server-side feature flags and configuration constants.
 *
 * Single source of truth for the BFF and voice agent.
 * Import from here — never inline magic numbers or strings in route handlers.
 *
 * To isolate a feature during testing, toggle its flag here.
 * Never disable one thing to make another work.
 */

// ─── Voice Agent ──────────────────────────────────────────────────────────────

export const VOICE_AGENT = {
  /** Claude model for LLM inference */
  LLM_MODEL: process.env['LLM_MODEL'] ?? 'claude-haiku-4-5-20251001',
  /** Local LLM proxy base URL */
  LLM_BASE_URL: process.env['ANTHROPIC_BASE_URL'] ?? 'http://localhost:8317',
  /**
   * API key for the local LLM proxy.
   * Per-request credential fetch (from Vault via get_user_credential RPC) is wired
   * in Story 4. This constant is no longer set here — callers must fetch it at
   * request time using getUserCredential(supabase, 'ANTHROPIC_API_KEY').
   */
  LLM_API_KEY: undefined as string | undefined,
  /**
   * STT model. Routed through LiveKit Inference (no separate Deepgram account
   * required — LiveKit holds the credential and bills via the LiveKit account).
   * `deepgram/nova-3` is the fastest streaming STT in 2026 (sub-300ms partial
   * latency) and the cheapest at $0.0077/min streaming. Override via STT_MODEL.
   */
  STT_MODEL: process.env['STT_MODEL'] ?? 'deepgram/nova-3',
  /**
   * TTS model. Routed through LiveKit Inference. `cartesia/sonic-3` has the
   * lowest time-to-first-audio on the market (~40-90ms via SSM architecture)
   * and beat ElevenLabs Flash V2 in blind preference tests. Override via TTS_MODEL.
   */
  TTS_MODEL: process.env['TTS_MODEL'] ?? 'cartesia/sonic-3',
  /**
   * Cartesia voice ID. Default is "Ronald". Override via TTS_VOICE.
   * Voice IDs are UUIDs; browse https://play.cartesia.ai.
   */
  TTS_VOICE: process.env['TTS_VOICE'] ?? '5ee9feff-1265-424a-9d7f-8e4d431a12c7',
  /** Number of history messages to load as context prefix */
  HISTORY_LIMIT: 10,
  /** VAD activation threshold (0–1; higher = less sensitive to background noise) */
  VAD_ACTIVATION_THRESHOLD: 0.65,
  /** Minimum speech duration in ms before VAD triggers */
  VAD_MIN_SPEECH_MS: 100,
  /** Minimum silence duration in ms before end-of-speech */
  VAD_MIN_SILENCE_MS: 450,
} as const

// ─── Research Tool ────────────────────────────────────────────────────────────

export const RESEARCH = {
  /** Master switch — set to false to skip research tool entirely */
  ENABLED: true,
  /** Timeout for the voice agent's research HTTP call (ms) — must exceed adapter timeout */
  VOICE_TIMEOUT_MS: 330_000,
  /** Timeout for the research adapter itself (ms) */
  ADAPTER_TIMEOUT_MS: 300_000,
  /** Internal shared secret for voice-agent→BFF JWT bypass (RESEARCH_INTERNAL_SECRET env var).
   *  Both the BFF middleware and the voice agent read this from the same env var.
   *  Empty string disables the bypass. */
  INTERNAL_SECRET: process.env['RESEARCH_INTERNAL_SECRET'] ?? '',
  /** Anthropic-compatible proxy URL for the SDK running inside the sandbox VM.
   *  Defaults to the in-sandbox CLIProxyAPI on localhost:8317, which speaks the
   *  Anthropic API shape and routes to whatever backend it's configured for
   *  (codex/Spark today). Override via SANDBOX_ANTHROPIC_BASE_URL. */
  SANDBOX_ANTHROPIC_BASE_URL: process.env['SANDBOX_ANTHROPIC_BASE_URL'] ?? 'http://localhost:8317',
  /** API key the sandbox SDK presents to the local proxy. Not a real Anthropic
   *  key — it's the proxy's allow-list value (see /opt/cliproxyapi/config.yaml). */
  SANDBOX_ANTHROPIC_API_KEY: process.env['SANDBOX_ANTHROPIC_API_KEY'] ?? 'c89a2ad0287a6d14b6ef94d92ad303f7',
  /** Default model for research runs. Must be a model ID the proxy knows. */
  SANDBOX_MODEL: process.env['SANDBOX_RESEARCH_MODEL'] ?? 'claude-sonnet-4-5-20250929',
  /** Working directory on the sandbox where research.mjs runs.
   *  Must contain @anthropic-ai/claude-agent-sdk in node_modules (provisioned by
   *  bootstrap.sh). The script is uploaded here per-invocation. */
  SANDBOX_WORKDIR: process.env['SANDBOX_RESEARCH_WORKDIR'] ?? '/opt/sandbox-research',
} as const

// ─── Room Limits ──────────────────────────────────────────────────────────────
/** Maximum number of agent participants allowed per room. Enforced by the token route before dispatch. */
export const MAX_AGENTS_PER_ROOM = 1

// ─── BFF Server ───────────────────────────────────────────────────────────────

export const BFF = {
  /** Port the Hono BFF listens on */
  PORT: 3001,
  /** Max SSE response time before timeout (ms) */
  SSE_TIMEOUT_MS: 300_000,
  /** Heartbeat interval for the /api/events SSE stream (ms) */
  SSE_HEARTBEAT_INTERVAL_MS: 15_000,
  /** Max concurrent SSE connections; excess requests receive 503 */
  SSE_MAX_CONNECTIONS: 50,
  /** Max per-connection process-ownership cache entries; uncached processes re-query the DB */
  SSE_PROCESS_CACHE_MAX: 1000,
} as const

// ─── Sandbox / SSH ────────────────────────────────────────────────────────────

/** Patterns in Codex stdout/stderr that indicate an auth failure requiring a fallback to Claude. */
export const CODEX_AUTH_ERROR_PATTERNS = [
  '401',
  'missing bearer',
  'session invalidated',
  'unauthorized',
  'invalid_grant',
] as const

export function isCodexAuthError(stdout: string, stderr: string): boolean {
  const combined = (stdout + stderr).toLowerCase()
  return CODEX_AUTH_ERROR_PATTERNS.some(p => combined.includes(p.toLowerCase()))
}

// ─── Artifacts ────────────────────────────────────────────────────────────────
//
// Artifact URLs are built via @skill-networks/artifact-url's buildArtifactUrl()
// using the single-label artifact-<sandboxId>-<port>.example.com format. There
// are no per-sandbox tunnel domains or openclaw host fallbacks — the wildcard
// *.example.com CNAME plus the artifact-router service handles every sandbox.
