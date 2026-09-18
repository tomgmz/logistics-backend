-- Teach create_user_with_profile about external drivers.
--
-- Full body restated rather than patched, following the precedent set by
-- 20260727010000_update_create_user_with_profile_remove_vendor.sql: CREATE OR
-- REPLACE cannot be partially applied, so the file has to carry the whole
-- function or it silently reverts whatever the last migration added.
--
-- Two changes, both in the driver branch:
--   * is_external is passed through, defaulting false so every existing caller
--     keeps producing company drivers;
--   * license_expiry is now NULLIF'd before the cast, because an external driver
--     has no expiry to record and ''::date would raise.
CREATE OR REPLACE FUNCTION public.create_user_with_profile(
  p_user_id uuid,
  p_role    text,
  p_user    jsonb,
  p_detail  jsonb DEFAULT NULL::jsonb
)
RETURNS users
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_user public.users;
BEGIN
  INSERT INTO public.users (
    user_id, email, first_name, last_name, middle_name, suffix,
    phone, role, created_by, must_change_password
  ) VALUES (
    p_user_id,
    p_user->>'email',
    p_user->>'first_name',
    p_user->>'last_name',
    p_user->>'middle_name',
    p_user->>'suffix',
    p_user->>'phone',
    p_role,
    NULLIF(p_user->>'created_by', '')::uuid,
    COALESCE((p_user->>'must_change_password')::boolean, false)
  )
  RETURNING * INTO v_user;

  IF p_role = 'client' THEN
    INSERT INTO public.clients (user_id, company_name, billing_address, billing_mode, landline)
    VALUES (
      p_user_id,
      p_detail->>'company_name',
      p_detail->>'billing_address',
      COALESCE(NULLIF(p_detail->>'billing_mode', ''), 'monthly'),
      p_detail->>'landline'
    );
  ELSIF p_role = 'driver' THEN
    INSERT INTO public.drivers (
      user_id, license_number, license_expiry, license_image_url, is_external
    )
    VALUES (
      p_user_id,
      p_detail->>'license_number',
      NULLIF(p_detail->>'license_expiry', '')::date,
      p_detail->>'license_image_url',
      COALESCE((p_detail->>'is_external')::boolean, false)
    );
  END IF;

  RETURN v_user;
END;
$function$;
