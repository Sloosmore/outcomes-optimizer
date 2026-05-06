-- Stage Manager: replace single-artifact columns with a jsonb array of tiles.
--
-- Today the chats row carries `artifact_url` + `artifact_port` — a single
-- "currently shared" iframe URL. The Stage Manager UI promotes that to a small
-- rail of recent artifacts (capped to 4). Index 0 is the active tile; new URLs
-- are prepended; duplicates are de-duped + promoted to the front.
--
-- Single user, no dual-direction migration: drop the legacy columns outright.
-- Entry shape is `{ "url": string }` — keeping it an object leaves room for
-- `title` / `favicon` later without another migration.

ALTER TABLE chats ADD COLUMN IF NOT EXISTS artifact_tiles jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE chats DROP COLUMN IF EXISTS artifact_url;
ALTER TABLE chats DROP COLUMN IF EXISTS artifact_port;

-- Renderer toggle: when true, the chat renders the multi-iframe Stage Manager;
-- when false (default), today's single full-bleed iframe view. Lets us A/B and
-- roll back without a deploy.
ALTER TABLE chats ADD COLUMN IF NOT EXISTS stage_mode boolean NOT NULL DEFAULT false;
