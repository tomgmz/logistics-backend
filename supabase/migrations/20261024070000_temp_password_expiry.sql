-- Generated (temporary) passwords stop working 7 days after they are issued.
--
-- temp_password_expires_at is owned by the trigger below, not by app code:
-- whenever must_change_password turns on (account created, IT Admin handover,
-- any future re-issue) the clock starts at now() + 7 days, and whenever it turns
-- off (the user set their own password, or a reset cleared it) the stamp is
-- dropped. Every path that writes users goes through it, including the
-- create_user_with_profile and transition_it_admin functions, so none of them
-- needed to change.
--
-- Password sign-in refuses a correct temporary password past this time
-- (auth.service loginWithPassword); the way back is a password reset. The 7 days
-- is mirrored by TEMP_PASSWORD_TTL_DAYS in src/lib/brevo-mailer.ts for the
-- welcome email copy; change both together.
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS temp_password_expires_at timestamptz;

CREATE OR REPLACE FUNCTION public.set_temp_password_expiry()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.must_change_password IS TRUE THEN
    IF TG_OP = 'INSERT' OR OLD.must_change_password IS DISTINCT FROM TRUE THEN
      NEW.temp_password_expires_at := now() + interval '7 days';
    END IF;
  ELSE
    NEW.temp_password_expires_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_set_temp_password_expiry ON public.users;
CREATE TRIGGER trg_set_temp_password_expiry
  BEFORE INSERT OR UPDATE OF must_change_password ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.set_temp_password_expiry();

-- Accounts already waiting on their first sign-in get the full 7 days from
-- today rather than from when they were created, so nobody is locked out the
-- moment this ships.
UPDATE public.users
   SET temp_password_expires_at = now() + interval '7 days'
 WHERE must_change_password IS TRUE
   AND temp_password_expires_at IS NULL;
