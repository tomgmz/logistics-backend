-- Client contract validity (2026-10-30): the date a client's contract with 8338
-- runs until. Set in User Management when the client account is created
-- (required there) and editable afterwards. Nullable because the clients that
-- already exist were created without one.
--
-- create_user_with_profile inserts a fixed list of client columns, so it is
-- redefined here (copied from the live definition) to carry the new one.

alter table public.clients
  add column if not exists contract_valid_until date;

CREATE OR REPLACE FUNCTION public.create_user_with_profile(p_user_id uuid, p_role text, p_user jsonb, p_detail jsonb DEFAULT NULL::jsonb)
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
    INSERT INTO public.clients (user_id, company_name, billing_address, landline, contract_valid_until)
    VALUES (
      p_user_id,
      p_detail->>'company_name',
      p_detail->>'billing_address',
      p_detail->>'landline',
      NULLIF(p_detail->>'contract_valid_until', '')::date
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
