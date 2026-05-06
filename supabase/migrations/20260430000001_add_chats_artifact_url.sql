-- Add artifact_url to chats so the iframe content survives a page reload.
-- Today share_screen sends an `artifact_ready` LiveKit data-channel message
-- carrying the URL but never persists it; on reload the chat row's
-- artifact_port column is null and the iframe goes blank. Storing the full
-- URL lets the frontend re-seed the artifact-url query cache on mount.
--
-- artifact_port (already exists) stays for backward compatibility with the
-- legacy port-based reconstruction path. New writes target artifact_url.
ALTER TABLE chats ADD COLUMN IF NOT EXISTS artifact_url TEXT;
