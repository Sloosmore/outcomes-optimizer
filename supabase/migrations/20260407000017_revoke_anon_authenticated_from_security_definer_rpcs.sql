-- Migration 20260407000017: Revoke anon and authenticated from all SECURITY DEFINER RPCs
-- Supabase default_acl grants explicit anon+authenticated to all public schema functions.
-- REVOKE FROM PUBLIC alone is insufficient. This migration explicitly revokes them.
-- provision_user is already handled in migration 000013 — skipped here.

REVOKE ALL ON FUNCTION public.validate_resource_name(TEXT) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.validate_link_type_pairing(TEXT, TEXT, TEXT) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.create_agent(TEXT, UUID, JSONB) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.create_proxy(TEXT, UUID, JSONB) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.create_skill(TEXT, UUID, JSONB) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.create_identity(TEXT, UUID, TEXT, JSONB) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.create_app(TEXT, UUID, JSONB) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.create_credential(TEXT, UUID, TEXT, JSONB) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.create_server(TEXT, UUID, JSONB) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.create_cron(TEXT, UUID, UUID, TEXT, BOOLEAN, TEXT, TEXT[]) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.create_project(TEXT) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.create_user(TEXT, UUID, JSONB) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.provision_sandbox(UUID, TEXT, TEXT, TEXT, TEXT) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.deprovision_sandbox(UUID, TEXT) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.assign_credential(UUID, UUID) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.assign_proxy(UUID, UUID) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.add_project_member(UUID, UUID) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.assign_parent(UUID, UUID) FROM anon, authenticated;
