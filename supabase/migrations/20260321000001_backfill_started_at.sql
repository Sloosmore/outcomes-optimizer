-- Backfill started_at for existing processes.
-- All rows had started_at = NULL; created_at is a safe approximation
-- because processes begin executing immediately upon creation.
UPDATE processes SET started_at = created_at WHERE started_at IS NULL;
