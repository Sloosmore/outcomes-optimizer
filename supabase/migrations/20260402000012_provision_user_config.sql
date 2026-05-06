-- Update provision_user() to populate config with display_name and description.
-- display_name is derived from the email prefix (dots/underscores → spaces, title case).
-- description defaults to 'builder'.
-- NOTE: This migration is superseded by 20260407000005_provision_user_property_system.sql
-- which replaces hardcoded config assembly with property-system-driven defaults.
-- This file is kept as a no-op placeholder to preserve migration ordering.

-- (superseded — see 20260407000005_provision_user_property_system.sql)
