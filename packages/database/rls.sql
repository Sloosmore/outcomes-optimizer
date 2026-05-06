-- Row Level Security: service-role-only access for all application tables.
--
-- Strategy: enable RLS on every table, then add a single permissive policy per
-- table that grants full access only to the service_role. All other roles
-- (anon, authenticated) are implicitly denied because no policy matches them.
--
-- Run this once against your Supabase project. It is idempotent: each policy
-- is dropped-if-exists before creation. ENABLE RLS is also safe to re-run.
-- Note: CREATE POLICY IF NOT EXISTS requires PG17+; Supabase runs PG15.
--
-- Wrapped in a transaction so a failure between DROP and CREATE never leaves
-- a table with RLS enabled but no policy. Under PostgreSQL's default READ
-- COMMITTED isolation, other sessions never observe the intermediate state
-- (policy dropped but not yet recreated) — they see the committed state as
-- of their statement start, so there is no enforcement gap.
--
-- If running via psql, add "\set ON_ERROR_STOP on" before this file to halt
-- immediately on any error rather than continuing with a broken transaction.

BEGIN;

-- ── traces ─────────────────────────────────────────────────────────────────────
ALTER TABLE "public"."traces" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service_role_full_access" ON "public"."traces";
CREATE POLICY "service_role_full_access"
  ON "public"."traces"
  AS PERMISSIVE FOR ALL TO public
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- ── resources ──────────────────────────────────────────────────────────────────
ALTER TABLE "public"."resources" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service_role_full_access" ON "public"."resources";
CREATE POLICY "service_role_full_access"
  ON "public"."resources"
  AS PERMISSIVE FOR ALL TO public
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- Authenticated users may SELECT their own user resource.
-- auth.uid() returns uuid; auth_user_id is text (widened in 20260421000001).
-- The ::text cast is required to avoid 42883 (operator does not exist: text = uuid).
DROP POLICY IF EXISTS "authenticated_select_own" ON "public"."resources";
CREATE POLICY "authenticated_select_own"
  ON "public"."resources"
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (auth_user_id = auth.uid()::text);

-- ── resource_links ─────────────────────────────────────────────────────────────
ALTER TABLE "public"."resource_links" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service_role_full_access" ON "public"."resource_links";
CREATE POLICY "service_role_full_access"
  ON "public"."resource_links"
  AS PERMISSIVE FOR ALL TO public
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- ── processes ────────────────────────────────────────────────────────────────
ALTER TABLE "public"."processes" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service_role_full_access" ON "public"."processes";
CREATE POLICY "service_role_full_access"
  ON "public"."processes"
  AS PERMISSIVE FOR ALL TO public
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- ── epoch_results ──────────────────────────────────────────────────────────────
ALTER TABLE "public"."epoch_results" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service_role_full_access" ON "public"."epoch_results";
CREATE POLICY "service_role_full_access"
  ON "public"."epoch_results"
  AS PERMISSIVE FOR ALL TO public
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- ── tags ───────────────────────────────────────────────────────────────────
ALTER TABLE "public"."tags" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service_role_full_access" ON "public"."tags";
CREATE POLICY "service_role_full_access"
  ON "public"."tags"
  AS PERMISSIVE FOR ALL TO public
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- ── tag_entities ─────────────────────────────────────────────────────────────
ALTER TABLE "public"."tag_entities" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service_role_full_access" ON "public"."tag_entities";
CREATE POLICY "service_role_full_access"
  ON "public"."tag_entities"
  AS PERMISSIVE FOR ALL TO public
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- ── process_dependencies ─────────────────────────────────────────────────────
ALTER TABLE "public"."process_dependencies" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service_role_full_access" ON "public"."process_dependencies";
CREATE POLICY "service_role_full_access"
  ON "public"."process_dependencies"
  AS PERMISSIVE FOR ALL TO public
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- ── logs ─────────────────────────────────────────────────────────────────────
ALTER TABLE "public"."logs" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service_role_full_access" ON "public"."logs";
CREATE POLICY "service_role_full_access"
  ON "public"."logs"
  AS PERMISSIVE FOR ALL TO public
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- ── resource_types ──────────────────────────────────────────────────────────────
ALTER TABLE "public"."resource_types" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service_role_full_access" ON "public"."resource_types";
CREATE POLICY "service_role_full_access"
  ON "public"."resource_types"
  AS PERMISSIVE FOR ALL TO public
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- ── link_types ────────────────────────────────────────────────────────────────
ALTER TABLE "public"."link_types" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service_role_full_access" ON "public"."link_types";
CREATE POLICY "service_role_full_access"
  ON "public"."link_types"
  AS PERMISSIVE FOR ALL TO public
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- ── link_type_rules ──────────────────────────────────────────────────────────
ALTER TABLE "public"."link_type_rules" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service_role_full_access" ON "public"."link_type_rules";
CREATE POLICY "service_role_full_access"
  ON "public"."link_type_rules"
  AS PERMISSIVE FOR ALL TO public
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- ── value_types ──────────────────────────────────────────────────────────────
ALTER TABLE "public"."value_types" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service_role_full_access" ON "public"."value_types";
CREATE POLICY "service_role_full_access"
  ON "public"."value_types"
  AS PERMISSIVE FOR ALL TO public
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- ── resource_type_properties ─────────────────────────────────────────────────
ALTER TABLE "public"."resource_type_properties" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service_role_full_access" ON "public"."resource_type_properties";
CREATE POLICY "service_role_full_access"
  ON "public"."resource_type_properties"
  AS PERMISSIVE FOR ALL TO public
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- ── agent_events ─────────────────────────────────────────────────────────────
ALTER TABLE "public"."agent_events" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service_role_full_access" ON "public"."agent_events";
CREATE POLICY "service_role_full_access"
  ON "public"."agent_events"
  AS PERMISSIVE FOR ALL TO public
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- ── chats ────────────────────────────────────────────────────────────────────
ALTER TABLE "public"."chats" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service_role_full_access" ON "public"."chats";
CREATE POLICY "service_role_full_access"
  ON "public"."chats"
  AS PERMISSIVE FOR ALL TO public
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- ── messages ──────────────────────────────────────────────────────────────────
ALTER TABLE "public"."messages" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service_role_full_access" ON "public"."messages";
CREATE POLICY "service_role_full_access"
  ON "public"."messages"
  AS PERMISSIVE FOR ALL TO public
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- ── metric_snapshots ─────────────────────────────────────────────────────────
ALTER TABLE "public"."metric_snapshots" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service_role_full_access" ON "public"."metric_snapshots";
CREATE POLICY "service_role_full_access"
  ON "public"."metric_snapshots"
  AS PERMISSIVE FOR ALL TO public
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- ── action_types ─────────────────────────────────────────────────────────────
ALTER TABLE "public"."action_types" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service_role_full_access" ON "public"."action_types";
CREATE POLICY "service_role_full_access"
  ON "public"."action_types"
  AS PERMISSIVE FOR ALL TO public
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- ── action_events ─────────────────────────────────────────────────────────────
ALTER TABLE "public"."action_events" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service_role_full_access" ON "public"."action_events";
CREATE POLICY "service_role_full_access"
  ON "public"."action_events"
  AS PERMISSIVE FOR ALL TO public
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- ── throwmail_messages ────────────────────────────────────────────────────────
ALTER TABLE "public"."throwmail_messages" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service_role_full_access" ON "public"."throwmail_messages";
CREATE POLICY "service_role_full_access"
  ON "public"."throwmail_messages"
  AS PERMISSIVE FOR ALL TO public
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- ── Supabase Storage buckets ────────────────────────────────────────────────
--
-- Storage RLS is enforced on storage.objects (one row per file) filtered by
-- bucket_id. Policies must be added here whenever a new bucket is created.
-- Naming convention: service_role_full_access_<bucket>, public_read_<bucket>.
--
-- Current buckets: traces (private), data (private), public-assets (public read)

-- traces — private: service_role only
-- Also drops the legacy unsuffixed name. This name was only ever used for the
-- traces bucket policy (same USING clause), so the DROP is safe and targeted.
DROP POLICY IF EXISTS "service_role_full_access" ON storage.objects;
DROP POLICY IF EXISTS "service_role_full_access_traces" ON storage.objects;
CREATE POLICY "service_role_full_access_traces"
  ON storage.objects
  AS PERMISSIVE FOR ALL TO public
  USING (bucket_id = 'traces' AND auth.role() = 'service_role')
  WITH CHECK (bucket_id = 'traces' AND auth.role() = 'service_role');

-- data — private: service_role only
DROP POLICY IF EXISTS "service_role_full_access_data" ON storage.objects;
CREATE POLICY "service_role_full_access_data"
  ON storage.objects
  AS PERMISSIVE FOR ALL TO public
  USING (bucket_id = 'data' AND auth.role() = 'service_role')
  WITH CHECK (bucket_id = 'data' AND auth.role() = 'service_role');

-- public-assets — public read, service_role write
DROP POLICY IF EXISTS "public_read_public_assets" ON storage.objects;
CREATE POLICY "public_read_public_assets"
  ON storage.objects
  AS PERMISSIVE FOR SELECT TO public
  USING (bucket_id = 'public-assets');

DROP POLICY IF EXISTS "service_role_write_public_assets" ON storage.objects;
CREATE POLICY "service_role_write_public_assets"
  ON storage.objects
  AS PERMISSIVE FOR ALL TO public
  USING (bucket_id = 'public-assets' AND auth.role() = 'service_role')
  WITH CHECK (bucket_id = 'public-assets' AND auth.role() = 'service_role');

COMMIT;
