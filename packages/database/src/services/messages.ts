import type postgres from 'postgres'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Sql = ReturnType<typeof postgres> | any

export interface Message {
  id: string
  chat_id: string
  role: string
  content: string
  created_at: string
}

export interface IMessagesService {
  create(chatId: string, role: string, content: string): Promise<Message>
  findByChatId(chatId: string, limit?: number): Promise<Message[]>
}

export class MessagesService implements IMessagesService {
  constructor(private sql: Sql) {}

  private serializeMessage(row: Record<string, unknown>): Message {
    return {
      ...row,
      created_at: row['created_at'] instanceof Date
        ? (row['created_at'] as Date).toISOString()
        : (row['created_at'] as string),
    } as unknown as Message
  }

  async create(chatId: string, role: string, content: string): Promise<Message> {
    const rows = await this.sql`
      INSERT INTO messages (chat_id, role, content) VALUES (${chatId}, ${role}, ${content})
      RETURNING id, chat_id, role, content, created_at
    `
    return this.serializeMessage(rows[0] as Record<string, unknown>)
  }

  async findByChatId(chatId: string, limit = 100): Promise<Message[]> {
    const rows = await this.sql`
      SELECT id, chat_id, role, content, created_at FROM messages
      WHERE chat_id = ${chatId} ORDER BY created_at ASC LIMIT ${limit}
    `
    return (rows as Record<string, unknown>[]).map(row => this.serializeMessage(row))
  }
}
