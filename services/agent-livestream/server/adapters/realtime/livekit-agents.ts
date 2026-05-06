/**
 * LiveKit agent runtime re-exports.
 *
 * @livekit/agents and its plugins depend on @livekit/rtc-node, a native binary
 * module compiled via Rust/NAPI. Native modules CANNOT run in Vercel's
 * serverless build environment.
 *
 * This file MUST NOT be imported from any file in the BFF import chain:
 *   api/index.ts → server/adapters/vercel.ts → server/app.ts → routes/* → ...
 *
 * It is ONLY imported by voice-agent.ts (and files it imports: local-llm.ts,
 * local-llm-stream.ts, tools/*). These all run as a standalone LiveKit agent
 * process (Node.js only), never on Vercel.
 *
 * BFF import chain isolation:
 *   livekit-adapter.ts  → livekit-server-sdk only (safe on Vercel)
 *   livekit-agents.ts   → @livekit/agents + plugins (Node.js agent process only)
 *   noise-cancellation.ts → @livekit/noise-cancellation-node (Node.js agent process only)
 */
export { cli, defineAgent, voice, llm, WorkerOptions, DEFAULT_API_CONNECT_OPTIONS, ServerOptions, inference } from '@livekit/agents'
export type { JobContext, JobProcess, APIConnectOptions } from '@livekit/agents'

// Agent plugin re-exports — these packages match the @livekit/agents* grep pattern
// so must be centralised in an adapter file, not imported directly from consuming files.
// STT/TTS now go through `inference.STT` / `inference.TTS` (LiveKit Inference) so the
// per-provider plugins are no longer needed at runtime. The OpenAI plugin re-export
// is kept as a fallback for any caller that still wants direct OpenAI access (none today).
export { VAD } from '@livekit/agents-plugin-silero'
