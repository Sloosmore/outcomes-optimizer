-- Add root_process_id: self-referencing FK (nullable, set by trigger)
ALTER TABLE processes
  ADD COLUMN IF NOT EXISTS root_process_id uuid REFERENCES processes(id);

-- Backfill: every existing row points to itself
UPDATE processes SET root_process_id = id WHERE root_process_id IS NULL;

-- Trigger: auto-set root_process_id = id on insert if not provided
CREATE OR REPLACE FUNCTION set_root_process_id()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.root_process_id IS NULL THEN
    NEW.root_process_id := NEW.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_set_root_process_id ON processes;
CREATE TRIGGER trigger_set_root_process_id
BEFORE INSERT ON processes
FOR EACH ROW EXECUTE FUNCTION set_root_process_id();

-- Enforce invariant: root_process_id must always be set
-- (trigger + backfill guarantee all rows are populated before this runs)
ALTER TABLE processes ALTER COLUMN root_process_id SET NOT NULL;

-- Add index for chain queries
CREATE INDEX IF NOT EXISTS processes_root_process_id_idx ON processes (root_process_id);
