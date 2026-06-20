-- Atomically create a public.users row plus its role-specific detail row
-- (clients/drivers/vendors) in a single transaction. If any insert fails,
-- the whole function rolls back, so no partial profile is ever committed.
-- Roles without a detail table simply get the users row.
CREATE OR REPLACE FUNCTION public.create_user_with_profile(
  p_user_id uuid,
  p_role    text,
  p_user    jsonb,
  p_detail  jsonb DEFAULT NULL
)
RETURNS public.users
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
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
    INSERT INTO public.clients (user_id, company_name, billing_address, payment_terms, landline)
    VALUES (
      p_user_id,
      p_detail->>'company_name',
      p_detail->>'billing_address',
      COALESCE((p_detail->>'payment_terms')::int, 30),
      p_detail->>'landline'
    );
  ELSIF p_role = 'driver' THEN
    INSERT INTO public.drivers (user_id, license_number, license_expiry, license_image_url, is_vendor_driver, vendor_id)
    VALUES (
      p_user_id,
      p_detail->>'license_number',
      (p_detail->>'license_expiry')::date,
      p_detail->>'license_image_url',
      COALESCE((p_detail->>'is_vendor_driver')::boolean, false),
      NULLIF(p_detail->>'vendor_id', '')::uuid
    );
  ELSIF p_role = 'vendor' THEN
    INSERT INTO public.vendors (user_id, vendor_type, company_name, business_permit)
    VALUES (
      p_user_id,
      p_detail->>'vendor_type',
      p_detail->>'company_name',
      p_detail->>'business_permit'
    );
  END IF;

  RETURN v_user;
END;
$$;

REVOKE ALL ON FUNCTION public.create_user_with_profile(uuid, text, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_user_with_profile(uuid, text, jsonb, jsonb) TO service_role;
