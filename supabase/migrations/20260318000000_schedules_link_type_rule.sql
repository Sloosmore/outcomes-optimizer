-- Add link_type_rules entry for the 'schedules' link type.
-- A cron resource schedules execution of a skill resource.
-- max_count=1 means each cron schedules at most one skill.

-- Remove stale cron->goal rule from earlier drizzle migration (0042) if present.
DELETE FROM link_type_rules
WHERE link_type = 'schedules' AND from_type = 'cron' AND to_type = 'goal';

INSERT INTO link_type_rules (link_type, from_type, to_type, min_count, max_count) VALUES
  ('schedules', 'cron', 'skill', 0, 1)
ON CONFLICT ON CONSTRAINT uq_link_type_rules DO NOTHING;
