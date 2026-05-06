-- Drop the UNIQUE constraint on processes.name (if any).
-- Lookup is column-based (exact single-column match on 'name') to avoid
-- accidentally matching unrelated constraints whose DDL text contains the word "name".
DO $$
DECLARE
  v_conname text;
BEGIN
  SELECT c.conname INTO v_conname
  FROM pg_constraint c
  JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
  WHERE c.conrelid = 'public.processes'::regclass
    AND c.contype = 'u'
    AND a.attname = 'name'
    AND array_length(c.conkey, 1) = 1
  LIMIT 1;

  IF v_conname IS NOT NULL THEN
    EXECUTE 'ALTER TABLE public.processes DROP CONSTRAINT ' || quote_ident(v_conname);
  END IF;
END $$;

-- Add non-unique index for lookup performance
CREATE INDEX IF NOT EXISTS processes_name_idx ON public.processes (name);
