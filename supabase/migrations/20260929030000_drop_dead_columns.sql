-- Drop columns with no reader or writer (schema audit, 2026-09-29).
--
-- Every column below was NULL in every row and unreferenced by the backend,
-- web and mobile code and by every database function — except fleet_status and
-- cargo_details, whose last readers are removed in the same commit:
--
--   bookings.fleet_status   the fleet approval stage retired in
--                           20260821000000_gm_first_approval_flow; its CHECK
--                           constraint goes with it.
--   bookings.cargo_details  the old free-text/JSON cargo blob, superseded by
--                           booking_cargo_items. The unused legacy RPCs
--                           get_all_bookings / get_bookings_by_client /
--                           get_booking_by_id still name it and will error if
--                           called; nothing calls them.
--
-- KEPT on purpose (the user wants them): bookings.total_cost,
-- bookings.estimated_delivery, drivers.emergency_contact_name/_phone.
--
-- No CASCADE: if anything unexpected depends on one of these, fail loudly.

begin;

alter table public.bookings   drop column if exists fleet_status;
alter table public.bookings   drop column if exists cargo_details;

alter table public.clients    drop column if exists tin;

alter table public.deliveries drop column if exists last_known_latitude;
alter table public.deliveries drop column if exists last_known_longitude;
alter table public.deliveries drop column if exists last_gps_update_at;
alter table public.deliveries drop column if exists proof_captured_at;
alter table public.deliveries drop column if exists proof_captured_latitude;
alter table public.deliveries drop column if exists proof_captured_longitude;

alter table public.active_sessions drop column if exists login_method;
alter table public.login_history   drop column if exists login_method;
alter table public.otp_codes       drop column if exists blocked_until;
alter table public.group_messages  drop column if exists deleted_by;

commit;
