-- Drop unused database functions, and the nightly cron job that had failed
-- every night since 2026-05-31. Applied 2026-09-29 (run by hand; this file
-- records it).
--
-- purge-reads (04:00 daily) ran purge_old_message_reads(), which deletes from
-- group_message_reads — a table that no longer exists (121 consecutive
-- failures). Removed rather than fixed: read receipts are now ONE pointer per
-- reader (group_members.last_read_at / last_read_message_id,
-- conversations.participant_a/b_last_read_at), updated in place, so nothing
-- piles up. purge-auth (03:00) is healthy and stays.
--
-- The functions below had no caller in the backend, web or mobile code, no
-- trigger, no cron job and no other function referencing them:
--   get_all_bookings, get_bookings_by_client, get_booking_by_id
--       legacy booking readers; they selected the dropped cargo_details.
--   clean_messaging_data
--       a development reset that wiped every conversation and all but one group.
--   cleanup_expired_auth_data
--       superseded by purge_expired_auth_data (purge-auth), which purges
--       sessions on refresh-token expiry instead of the 15-minute access token.

begin;

select cron.unschedule('purge-reads')
 where exists (select 1 from cron.job where jobname = 'purge-reads');

drop function if exists public.purge_old_message_reads();
drop function if exists public.get_all_bookings();
drop function if exists public.get_bookings_by_client(uuid);
drop function if exists public.get_booking_by_id(uuid);
drop function if exists public.clean_messaging_data();
drop function if exists public.cleanup_expired_auth_data();

commit;
