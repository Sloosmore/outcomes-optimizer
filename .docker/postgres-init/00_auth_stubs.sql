-- Auth schema stubs for plain postgres (no full Supabase stack).
-- Creates the auth schema, a minimal auth.users table, and stub functions
-- that migrations reference via RLS policies and security definer functions.

-- ── 1. Auth schema ────────────────────────────────────────────────────────────

CREATE SCHEMA IF NOT EXISTS auth;

-- ── 2. Minimal auth.users table ───────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS auth.users (
  id    uuid PRIMARY KEY,
  email text
);

-- ── 3. Supabase role stubs ────────────────────────────────────────────────────
-- Supabase creates these roles automatically; plain postgres does not.
-- CREATE ROLE IF NOT EXISTS is not valid syntax before PG 16, use DO block.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN;
  END IF;
END
$$;

-- ── 4. Auth function stubs ────────────────────────────────────────────────────
-- These are called in RLS policies and SECURITY DEFINER functions.
-- Stubs return safe defaults so policies evaluate without error.

-- auth.uid() — returns NULL (no authenticated user in plain postgres context)
CREATE OR REPLACE FUNCTION auth.uid()
RETURNS uuid
LANGUAGE sql STABLE
AS $$ SELECT NULL::uuid $$;

-- auth.role() — returns 'anon' (lowest-privilege default)
CREATE OR REPLACE FUNCTION auth.role()
RETURNS text
LANGUAGE sql STABLE
AS $$ SELECT 'anon'::text $$;

-- auth.jwt() — returns NULL (no JWT in plain postgres context)
CREATE OR REPLACE FUNCTION auth.jwt()
RETURNS jsonb
LANGUAGE sql STABLE
AS $$ SELECT NULL::jsonb $$;

-- ── 5. Supabase realtime publication stub ─────────────────────────────────────
-- Migrations reference "supabase_realtime" publication via ALTER PUBLICATION.
-- Create it as an empty publication so those statements succeed.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    EXECUTE 'CREATE PUBLICATION supabase_realtime';
  END IF;
END
$$;
