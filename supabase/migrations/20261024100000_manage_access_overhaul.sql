-- Manage Access overhaul (2026-10-24).
--
-- 1. Password resets: the IT Administrator now handles every request, staff,
--    drivers and clients alike. New requests file into 'it_admin'; the open
--    ones still sitting in the Company Administrator's queue move over so
--    nobody waiting is stranded in a queue no one can see any more.
-- 2. Tickets becomes a Manage Access module ('support-tickets'), so a Read Only
--    Administrator / Operations Manager can read tickets but not answer them.
-- 3. (Nothing for BLOWBAGETS: it is run from Vehicle Management, where the
--    server already needs the Manage All tier to record one.)
-- 4. Transit Tracking, Transaction History and Audit Logs have nothing to
--    change, so Manage Access only offers Read Only for them. Saved rows above
--    that are brought down to Read Only (view + export).
-- 5. A paused delivery gets an expected continuation date + the driver's call
--    time for it, set by Operations / the Company Administrator.
-- 6. Resolving a client-reported problem now carries remarks, sent to the client.

-- 1 ----------------------------------------------------------------------------
update public.password_reset_requests
   set handler_group = 'it_admin'
 where handler_group = 'company_admin'
   and status in ('pending', 'sent', 'expired');

-- 2 ----------------------------------------------------------------------------
alter table public.module_permissions drop constraint if exists module_permissions_module_name_check;
alter table public.module_permissions add constraint module_permissions_module_name_check
  check (module_name in (
    'user-management',
    'booking-management',
    'vehicle-management',
    'document-management',
    'transit-tracking',
    'transaction-history',
    'system-maintenance',
    'audit-logs',
    'reports',
    'support-tickets'
  ));

-- Only users who already have saved rows: a user without any rows falls back
-- to their role defaults, which include Tickets already.
insert into public.module_permissions
  (user_id, module_name, can_view, can_create, can_edit, can_delete, can_export)
select u.user_id, 'support-tickets', true, true, true, true, true
from public.users u
where u.role in ('admin', 'operations_manager')
  and u.status <> 'archived'
  and exists (select 1 from public.module_permissions mp where mp.user_id = u.user_id)
on conflict (user_id, module_name) do nothing;

-- 4 ----------------------------------------------------------------------------
update public.module_permissions
   set can_create = false, can_edit = false, can_delete = false, can_export = true
 where module_name in ('transit-tracking', 'transaction-history', 'audit-logs')
   and can_view
   and (can_create or can_edit or can_delete);

-- 5 ----------------------------------------------------------------------------
alter table public.booking_pauses
  add column if not exists expected_resume_date      date,
  add column if not exists expected_resume_call_time time,
  add column if not exists expected_resume_set_by    uuid references public.users(user_id) on delete set null,
  add column if not exists expected_resume_set_at    timestamptz;

comment on column public.booking_pauses.expected_resume_date is
  'When the paused delivery is expected to continue (Manila date). The client is told this date.';
comment on column public.booking_pauses.expected_resume_call_time is
  'The time the driver should report for the continuation. Told to the driver with the date.';

-- 5b. A crew replaced with a vendor's crew: the vendor vehicle is typed, never
--     registered, so its plate is kept here (as old_vehicle_plate already is).
alter table public.crew_replacements
  add column if not exists new_vehicle_plate text;

-- 6 ----------------------------------------------------------------------------
alter table public.bookings
  add column if not exists client_issue_resolution_note text;

comment on column public.bookings.client_issue_resolution_note is
  'What staff did about the client''s reported problem, written when marking it resolved and sent to the client. Cleared if the client reports again.';
