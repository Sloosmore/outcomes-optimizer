-- Add link_type_rules entries for 'runs' (agent → skill and user → skill)
-- 'runs' is the assignment link type: "this agent/user is running this skill"
-- Separate from 'parent' (OKR hierarchy) — keep them semantically distinct.
-- Also adds parent: user → agent so users can own agents in the hierarchy.

-- First ensure the 'runs' link type exists
INSERT INTO link_types (name, description, cardinality)
VALUES ('runs', 'Agent or user is running/executing this skill', 'many-to-many')
ON CONFLICT (name) DO NOTHING;

INSERT INTO link_type_rules (link_type, from_type, to_type, min_count, max_count)
VALUES ('runs', 'agent', 'skill', 0, NULL)
ON CONFLICT ON CONSTRAINT uq_link_type_rules DO NOTHING;

INSERT INTO link_type_rules (link_type, from_type, to_type, min_count, max_count)
VALUES ('runs', 'user', 'skill', 0, NULL)
ON CONFLICT ON CONSTRAINT uq_link_type_rules DO NOTHING;

INSERT INTO link_type_rules (link_type, from_type, to_type, min_count, max_count)
VALUES ('parent', 'user', 'agent', 0, NULL)
ON CONFLICT ON CONSTRAINT uq_link_type_rules DO NOTHING;
