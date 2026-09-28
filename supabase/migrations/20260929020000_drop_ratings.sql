-- Drop ratings — never wired to any screen, empty when dropped (2026-09-29),
-- no inbound foreign keys and no code reference.
--
-- The other empty legacy tables (chatbot_tickets, ticket_messages,
-- gps_tracking, maintenance_records, vehicle_coding_schedules, documents,
-- maintenance_requests) are deliberately KEPT for planned features.

begin;

drop table if exists public.ratings;

commit;
