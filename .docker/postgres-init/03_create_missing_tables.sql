-- Create tables that exist in schema.ts but are not created by migrations.
-- Uses CREATE TABLE IF NOT EXISTS for idempotency.

-- Chats: agent-livestream chat persistence
CREATE TABLE IF NOT EXISTS chats (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  artifact_port integer
);

-- Messages: chat messages (belongs to a chat)
CREATE TABLE IF NOT EXISTS messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id uuid NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  role text NOT NULL,
  content text NOT NULL DEFAULT '',
  tool_calls jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_messages_chat_id_created ON messages(chat_id, created_at);

-- Throwmail messages: outbound email records
CREATE TABLE IF NOT EXISTS throwmail_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  to_address text NOT NULL,
  from_address text,
  subject text,
  body text,
  created_at timestamptz NOT NULL DEFAULT now()
);
