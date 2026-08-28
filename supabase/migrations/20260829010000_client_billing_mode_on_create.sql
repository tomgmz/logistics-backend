-- Client creation captures the reverse billing arrangement, not a payment term.
--
-- 20260828000000_reverse_billing.sql added clients.billing_mode and marked
-- clients.payment_terms deprecated, but account creation was still collecting
-- the 30/45/60 term and never set billing_mode — so every client created after
-- that migration landed with a null mode, which is exactly the state the
-- billing period generator skips (billing.model.ts filters
-- `.not('billing_mode', 'is', null)`). Those clients would silently never get a
-- billing period.
--
-- The 30/45/60 term is a per-booking figure (bookings.payment_terms, chosen in
-- the booking form and read at invoice issuance); the weekly/monthly
-- arrangement is per-client and comes from the contract. This moves the RPC
-- onto the latter.

-- 1. billing_mode is now mandatory ------------------------------------------
-- Every existing row was backfilled to 'monthly' by the reverse billing
-- migration, so this cannot fail on data. The default keeps any insert path
-- that omits the column producing a billable client rather than an invisible
-- one.
alter table public.clients
  alter column billing_mode set default 'monthly';

update public.clients set billing_mode = 'monthly' where billing_mode is null;

alter table public.clients
  alter column billing_mode set not null;

-- 2. Provision clients with their arrangement --------------------------------
-- payment_terms is deliberately left out of the INSERT: the column keeps its
-- table default for the rows that still carry history, and nothing writes it
-- any more.
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
    INSERT INTO public.clients (user_id, company_name, billing_address, billing_mode, landline)
    VALUES (
      p_user_id,
      p_detail->>'company_name',
      p_detail->>'billing_address',
      COALESCE(NULLIF(p_detail->>'billing_mode', ''), 'monthly'),
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
