ALTER TABLE chats ADD COLUMN IF NOT EXISTS artifact_port INTEGER
  CHECK (artifact_port IS NULL OR (artifact_port >= 1 AND artifact_port <= 65535));
