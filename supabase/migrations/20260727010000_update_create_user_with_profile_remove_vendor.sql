-- Follow-up to 20260727000000_remove_vendor.sql: the create_user_with_profile RPC
-- still inserted drivers.is_vendor_driver / drivers.vendor_id (dropped columns) and
-- had a 'vendor' branch inserting into the dropped vendors table. Driver creation
-- failed with: column "is_vendor_driver" of relation "drivers" does not exist.

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
    INSERT INTO public.clients (user_id, company_name, billing_address, payment_terms, landline)
    VALUES (
      p_user_id,
      p_detail->>'company_name',
      p_detail->>'billing_address',
      COALESCE((p_detail->>'payment_terms')::int, 30),
      p_detail->>'landline'
    );
  ELSIF p_role = 'driver' THEN
    INSERT INTO public.drivers (user_id, license_number, license_expiry, license_image_url)
    VALUES (
      p_user_id,
      p_detail->>'license_number',
      (p_detail->>'license_expiry')::date,
      p_detail->>'license_image_url'
    );
  END IF;

  RETURN v_user;
END;
$function$;
