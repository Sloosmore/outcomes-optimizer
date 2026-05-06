-- Fix RLS on public.resources so the authenticated role can SELECT its own
-- user resource via PostgREST.
--
-- Empirical symptom (reproduced 2026-05-05):
--   GET /rest/v1/resources?type=eq.user (as authenticated)
--   → 42883: operator does not exist: text = uuid
--
-- The CLI's `repo list` path opens an anon-key + JWT (role=authenticated)
-- and runs:
--   .from('resources').select('config').eq('type','user').eq('auth_user_id', sub)
-- Since `auth_user_id` was widened from uuid → text in 20260421000001 but
-- pre-existing policies and ad-hoc policies created against the original
-- column compared `auth.uid()` (uuid) directly to `auth_user_id` (now text),
-- PostgREST surfaces a planner error before any row is returned.
--
-- This migration:
--   1. Drops every authenticated/anon/public-targeted policy that may have
--      been created against `public.resources` and `public.resource_links`,
--      so any drifted definition (created via dashboard or in a prior
--      migration that has since been amended) is removed.
--   2. Re-creates a single `authenticated_select_own` policy on each table
--      that compares using the correct `auth.uid()::text` cast.
--   3. Leaves the canonical service_role_full_access policy alone.
--
-- Idempotent: every DROP uses IF EXISTS, every CREATE is preceded by a DROP.
-- Safe to re-run.

BEGIN;

-- ── public.resources ─────────────────────────────────────────────────────────
ALTER TABLE public.resources ENABLE ROW LEVEL SECURITY;

-- Drop every known and suspected drifted policy name. Names cover:
--   - "authenticated_select_own"      (canonical name we are establishing)
--   - "Users can view own resource"   (common dashboard-generated label)
--   - "users_select_own"              (legacy snake_case variant)
--   - "auth_user_select"              (another seen-in-the-wild label)
DROP POLICY IF EXISTS "authenticated_select_own"     ON public.resources;
DROP POLICY IF EXISTS "Users can view own resource"  ON public.resources;
DROP POLICY IF EXISTS "users_select_own"             ON public.resources;
DROP POLICY IF EXISTS "auth_user_select"             ON public.resources;

-- Defensive sweep: drop any remaining policy on public.resources whose
-- USING/WITH CHECK qualifier references auth.uid() against auth_user_id
-- without a ::text cast. This catches dashboard-created policies whose
-- exact name we cannot predict but whose qual is detectable in pg_policies.
DO $$
DECLARE
  pol record;
BEGIN
  FOR pol IN
    SELECT policyname
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename  = 'resources'
      AND policyname <> 'service_role_full_access'
      AND (
        coalesce(qual, '')      ~ 'auth\.uid\(\)'
        OR coalesce(with_check, '') ~ 'auth\.uid\(\)'
      )
      AND coalesce(qual, '')         !~ 'auth\.uid\(\)::text'
      AND coalesce(with_check, '')   !~ 'auth\.uid\(\)::text'
  LOOP
    EXECUTE format(
      'DROP POLICY IF EXISTS %I ON public.resources',
      pol.policyname
    );
  END LOOP;
END $$;

-- Re-create the canonical authenticated select policy with the correct cast.
-- auth.uid() returns uuid; auth_user_id is text (post-20260421000001) — the
-- ::text cast is required to avoid 42883.
CREATE POLICY "authenticated_select_own"
  ON public.resources
  AS PERMISSIVE FOR SELECT
  TO authenticated
  USING (auth_user_id = auth.uid()::text);

-- ── public.resource_links ────────────────────────────────────────────────────
-- Same defensive sweep on resource_links: any policy that compares auth.uid()
-- to a text column without ::text would fail identically. resource_links has
-- no auth_user_id column, but it joins to resources, and dashboard-created
-- policies sometimes embed `auth.uid()` in subqueries. Keep parity.
ALTER TABLE public.resource_links ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  pol record;
BEGIN
  FOR pol IN
    SELECT policyname
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename  = 'resource_links'
      AND policyname <> 'service_role_full_access'
      AND (
        coalesce(qual, '')      ~ 'auth\.uid\(\)'
        OR coalesce(with_check, '') ~ 'auth\.uid\(\)'
      )
      AND coalesce(qual, '')         !~ 'auth\.uid\(\)::text'
      AND coalesce(with_check, '')   !~ 'auth\.uid\(\)::text'
  LOOP
    EXECUTE format(
      'DROP POLICY IF EXISTS %I ON public.resource_links',
      pol.policyname
    );
  END LOOP;
END $$;

COMMIT;
