-- Make resource_id nullable on agent_events.
-- Unlinked processes (dispatched without a skill resource) have no resource to link to.
-- Cursors in the graph simply won't render for these processes (resource_id = null → no node match).
ALTER TABLE agent_events ALTER COLUMN resource_id DROP NOT NULL;
