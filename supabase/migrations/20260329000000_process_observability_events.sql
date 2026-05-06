-- Documents three new agent_events.source values for process observability.
-- No schema changes — agent_events.source is an untyped text column.
-- This migration is intentionally a no-op; it exists to record semantics in
-- version control so all readers of the events table share a common definition.

-- source: process_continued
-- Emitted on the dead process (status failed or completed) when `process restart`
-- creates a child continuation. Payload: {new_process_id: UUID}.
-- Indicates this process has a continuation and consumers should follow the chain
-- forward to new_process_id to observe ongoing execution.

-- source: process_born_from
-- Emitted on the new child process created by `process restart`.
-- Payload: {dead_process_id: UUID, epoch_number: string}.
-- Indicates lineage — this process was born from a restart of dead_process_id.
-- epoch_number is a monotonically increasing string counter within the restart chain.

-- source: goal_amended
-- Emitted on a process when `process amend` appends text to its goal.
-- Payload: {before: string, after: string}.
-- Records the full goal content before and after the amendment so consumers can
-- diff what changed without needing to query the processes table separately.

DO $$ BEGIN END $$;
