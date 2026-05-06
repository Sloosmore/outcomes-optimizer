-- Add link_type_rules entry for 'parent (server → user)'
-- A server resource can have a parent user resource (the user who owns it).
INSERT INTO link_type_rules (link_type, from_type, to_type, min_count, max_count)
VALUES ('parent', 'server', 'user', 0, 1)
ON CONFLICT ON CONSTRAINT uq_link_type_rules DO NOTHING;
