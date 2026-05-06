-- Fix: handle_new_auth_user trigger was calling provision_user with 3 arguments
-- (id, email, raw_user_meta_data) but the function only accepts 2 (id, email).
-- This caused "Database error creating new user" on every auth.admin.createUser call.

CREATE OR REPLACE FUNCTION handle_new_auth_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER
AS $$
BEGIN
  PERFORM public.provision_user(NEW.id, NEW.email);
  RETURN NEW;
END;
$$;
