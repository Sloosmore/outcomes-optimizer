-- Drop the text overload of assign_credential to resolve PostgREST ambiguity (PGRST203).
-- The text overload was added in migration 20260407000020 as a convenience wrapper that
-- casts to uuid. PostgREST cannot disambiguate between text and uuid overloads when
-- called via HTTP RPC (both match JSON string parameters), causing status 300 errors.
-- The uuid overload is the canonical version; callers should pass UUIDs directly.
DROP FUNCTION IF EXISTS public.assign_credential(p_from_id text, p_to_id text);
