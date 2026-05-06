import type { Message } from '@skill-networks/database/services'
import { getServices } from './services.js'

/**
 * Single canonical entry point for persisting a chat turn.
 *
 * The persistence-call-site invariant test asserts that this is the only
 * place in server/ source code that invokes the underlying persistence
 * service for a chat turn. Routing every persistence through this helper
 * guarantees consistent ordering, logging, and downstream signalling.
 */
export async function persistTurn(
  chatId: string,
  role: 'user' | 'assistant',
  text: string,
): Promise<Message> {
  return getServices().messages.create(chatId, role, text)
}
