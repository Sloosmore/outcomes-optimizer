-- Idempotent test seed data for compose DB.
-- Creates two users (user-a, user-b), each with their own project, via provision_user().
-- Also creates a test skill and a test process.
-- Safe to run multiple times: ON CONFLICT DO NOTHING / ON CONFLICT DO UPDATE.

-- Insert auth user stubs with fixed UUIDs
INSERT INTO auth.users (id, email)
VALUES
  ('11111111-1111-1111-1111-111111111111', 'user-a@compose.local'),
  ('22222222-2222-2222-2222-222222222222', 'user-b@compose.local')
ON CONFLICT (id) DO NOTHING;

-- Provision user-a (creates user resource + project:user-a + member_of link)
SELECT provision_user(
  '11111111-1111-1111-1111-111111111111'::uuid,
  'user-a@compose.local'
);

-- Provision user-b (creates user resource + project:user-b + member_of link)
SELECT provision_user(
  '22222222-2222-2222-2222-222222222222'::uuid,
  'user-b@compose.local'
);

-- Insert a test skill resource
INSERT INTO resources (name, type, status)
VALUES ('test-skill', 'skill', 'active')
ON CONFLICT (name) DO NOTHING;

-- Insert a test process
INSERT INTO processes (id, name, status, current_epoch, root_process_id)
VALUES (
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid,
  'test-process',
  'pending',
  0,
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid
)
ON CONFLICT (id) DO NOTHING;
