-- Retroactive fix: auth_user_id was missing from the baseline resources table
-- but referenced by migrations starting at 20260401000008. This migration is
-- intentionally placed at 20260401000007b to ensure correct order on fresh replay.
ALTER TABLE public.resources ADD COLUMN IF NOT EXISTS auth_user_id uuid
  REFERENCES auth.users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS resources_auth_user_id_idx ON public.resources (auth_user_id);
