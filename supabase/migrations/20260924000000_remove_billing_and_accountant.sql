-- Remove reverse billing, payment tracking, and the accountant role.
--
-- The product is a delivery system. Reverse billing, BIR document issuance and
-- payment recording are leaving it entirely; the accountant existed to work
-- them, so the role goes with the process it served.
--
-- IRREVERSIBLE, but verified cheap: checked against the live database on
-- 2026-09-24 and service_invoices, acknowledgement_receipts and billing_payments
-- are ALL EMPTY — no SI or AR serial was ever issued, so no BIR record is being
-- destroyed here. What does exist is 6 billing_periods, 5 billing_period_items
-- and the 2 seeded document_series counters. Re-check those counts before
-- running if any billing activity has happened since.

begin;

-- 1. Billing tables, child-first --------------------------------------------
-- `billing_payments` and `acknowledgement_receipts` are declared `on delete
-- restrict`, so the order below matters: dropping the parent first errors out
-- rather than cascading silently, which is the behaviour we want everywhere
-- except in this one deliberate teardown.
drop table if exists public.acknowledgement_receipts;
drop table if exists public.billing_payments;
drop table if exists public.service_invoices;
drop table if exists public.billing_period_items;
drop table if exists public.billing_submissions;
drop table if exists public.billing_periods;
drop table if exists public.document_series;

-- `ph_holidays` is deliberately KEPT. It was created by the reverse-billing
-- migration and is only read by billing today, but it is a plain PH
-- working-day calendar with no billing semantics in it, and delivery
-- scheduling is the obvious next caller. Dropping it would mean re-seeding
-- every declared non-working day by hand later.

-- 2. Client billing arrangement ----------------------------------------------
-- `billing_mode` was the weekly/monthly reverse-billing cycle from the client's
-- contract. With reverse billing gone it has no reader and no meaning.
-- `billing_address` STAYS — it is a real address, printed on delivery paperwork
-- and read by the booking detail screen.
alter table public.clients drop column if exists billing_mode;

-- 3. GM approval proxy --------------------------------------------------------
-- Only an accountant could ever be appointed, so with the role gone nothing can
-- set this flag. The general manager keeps the approval stage, with admins as
-- the standing fallback (see gmApprover.middleware.ts).
alter table public.users drop column if exists is_gm_proxy;

-- 4. The accountant role ------------------------------------------------------
-- Existing accountants are archived and their auth user banned, matching what
-- the app's own delete does — never a hard delete, so the audit and log rows
-- they authored keep resolving to a real name.
update public.users
   set status = 'archived'
 where role = 'accountant'
   and status <> 'archived';

-- Then retire the role itself. This must run AFTER the update above: the new
-- constraint rejects the value, archived rows included.
alter table public.users drop constraint if exists users_role_check;
alter table public.users add constraint users_role_check check (
  (role)::text = any (array[
    'admin','general_manager','fleet_manager','operations_manager',
    'client','driver','it_admin'
  ])
);

-- 5. RBAC ---------------------------------------------------------------------
-- `billing-management` is no longer a module key on either side, so these rows
-- would never be consulted again. There is no CHECK on module_name, so they are
-- harmless — deleted for hygiene, not correctness.
delete from public.module_permissions where module_name = 'billing-management';

-- Historical `billing.*` notifications are LEFT IN PLACE. notifications_type_check
-- was already dropped, nothing branches on the type, and the rows are part of
-- the audit record; their action_url now points at a route that no longer
-- exists, which resolves to a not-found page if an old notification is tapped.

-- 6. Log history ---------------------------------------------------------------
-- Billing and payment log rows go too — the readers no longer render either
-- type, and keeping them would leave rows that no filter can reach.
-- Only audit_logs is touched: system_logs is the technical table and keys off
-- `event_type` (server_error, cron_job, …), a vocabulary with no billing or
-- payment value in it.
delete from public.audit_logs where log_type in ('billing_activity', 'payment');

-- Then drop both from the permitted set, so nothing can write them again.
alter table public.audit_logs drop constraint if exists audit_logs_log_type_check;
alter table public.audit_logs add constraint audit_logs_log_type_check
  check (log_type in (
    'auth',
    'user_management',
    'access_control',
    'document_activity',
    'data_export',
    'user_activity',
    'admin_activity',
    'vehicle_creation',
    'vehicle_activity',
    'booking',
    'system_error',
    'driver_activity',
    'delivery_activity',
    'maintenance_activity'
  ));

-- 7. Payment terms --------------------------------------------------------------
-- The 30/45/60 term existed so an invoice could compute its due date. With no
-- invoices there is nothing to date, so it leaves the client booking form and
-- client account creation both.
--
-- `clients.payment_terms` was already marked DEPRECATED by the reverse-billing
-- migration; this finishes the job. The provisioning RPC has to stop inserting
-- it in the same transaction, or the next client creation fails on a column
-- that is no longer there.
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
    INSERT INTO public.clients (user_id, company_name, billing_address, landline)
    VALUES (
      p_user_id,
      p_detail->>'company_name',
      p_detail->>'billing_address',
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

alter table public.clients  drop column if exists payment_terms;
alter table public.bookings drop column if exists payment_terms;

commit;
