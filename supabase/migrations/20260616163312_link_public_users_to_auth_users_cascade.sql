-- Link public.users to auth.users so deleting the auth identity cascades
-- to the profile row (and from there to clients/drivers/vendors, which
-- already cascade off public.users). This makes the auth-user rollback in
-- the admin/user services actually clean up the profile instead of orphaning it.

-- user_id must always equal the auth identity id; the gen_random_uuid()
-- default could silently create a profile with no matching auth user.
ALTER TABLE public.users ALTER COLUMN user_id DROP DEFAULT;

ALTER TABLE public.users
  ADD CONSTRAINT users_user_id_auth_fkey
  FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
