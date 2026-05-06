-- Drop the unique index first
DROP INDEX IF EXISTS uq_cron_executions_per_minute;

-- Drop the table
DROP TABLE IF EXISTS cron_executions;
