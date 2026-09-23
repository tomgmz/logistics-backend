-- Close the other half of users_user_id_auth_fkey.
--
-- That FK cascades auth.users -> public.users only. Deleting a profile row
-- directly (table editor, ad-hoc SQL) left the auth identity behind: still
-- able to sign in against Supabase, email still reserved, and invisible to
-- every admin screen because they all read public.users. This trigger makes a
-- hard delete of the profile take the auth user with it.
--
-- The app never hard-deletes users (Delete archives + bans), so this only
-- fires for out-of-band deletes and the auth-user rollback cascade. In the
-- cascade case the auth row is already gone, so the delete below matches
-- nothing and the recursion ends there.

CREATE OR REPLACE FUNCTION public.delete_auth_user_on_profile_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  DELETE FROM auth.users WHERE id = OLD.user_id;
  RETURN OLD;
END;
$$;

REVOKE ALL ON FUNCTION public.delete_auth_user_on_profile_delete() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS users_delete_auth_user ON public.users;
CREATE TRIGGER users_delete_auth_user
  AFTER DELETE ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.delete_auth_user_on_profile_delete();
