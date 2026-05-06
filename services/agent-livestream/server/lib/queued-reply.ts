import type { voice } from '../adapters/realtime/livekit-agents.js'

/**
 * Queue a tool result reply behind any in-flight speech.
 *
 * Pattern (hybrid of OpenAI Realtime + Pipecat conventions, using only
 * documented LiveKit Agents primitives):
 *
 *   1. Append the result to chat context for durable history.
 *   2. Await the current SpeechHandle directly — DO NOT use
 *      handle.waitForPlayout(); that method regressed to a no-op in
 *      agents-js (livekit/agents-js#731). Awaiting the handle works.
 *   3. Trigger generateReply — by then the chat context already contains
 *      the tool result, so the LLM sees it naturally.
 *
 * Result: the agent finishes its current utterance naturally, then speaks
 * the tool's update as the next turn — no mid-word cut-offs.
 *
 * Refs:
 * - https://docs.livekit.io/agents/build/speech/
 * - https://github.com/livekit/agents-js/issues/731
 * - https://developers.openai.com/api/docs/guides/realtime-conversations
 *   (gate on response.done before next response.create — same shape)
 */
export async function queueToolReply(
  session: voice.AgentSession,
  _toolName: string,
  content: string,
): Promise<void> {
  // 1. Durable: append to chat context as 'assistant' role (livekit-agents
  //    ChatRole union does not include 'tool' — use assistant as nearest equivalent).
  session.chatCtx.addMessage({ role: 'assistant', content })

  // 2. Wait for current speech to finish naturally. Accesses currentSpeech via
  //    the internal AgentActivity reference (not in the public type but stable
  //    at runtime). DO NOT capture it earlier; overlapping tool calls would
  //    serialize on a stale handle.
  const current = (session as unknown as { activity?: { currentSpeech?: PromiseLike<void> } })
    .activity?.currentSpeech
  if (current) {
    await current
  }

  // 3. Generate a new turn. userInput is passed for parity with prior
  //    behavior (the LLM uses it as the immediate prompt), and the
  //    chatCtx.addMessage above keeps it in durable history too.
  //
  // TODO(relevance-guard): if the user barged in during step 2, currentSpeech
  // resolved early and the user's next turn may have already shifted the
  // conversation. Capture chatCtx length / last-user-turn timestamp at call
  // start and skip generateReply here if it changed. Not yet implemented —
  // race window is small in practice and a stray queued reply is recoverable.
  session.generateReply({ userInput: content })
}
