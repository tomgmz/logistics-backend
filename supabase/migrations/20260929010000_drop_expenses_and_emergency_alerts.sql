-- Drop expenses and emergency_alerts — both unused.
--
-- emergency_alerts predates the Reports module. The driver's SOS (quick alert)
-- and the detailed report are one driver_reports row (POST /driver/reports);
-- nothing has written emergency_alerts since. expenses was never wired to any
-- screen. Both were empty when dropped (2026-09-29), with no inbound foreign
-- keys, views or realtime publication.
--
-- The only code touching either was booking delete detaching their
-- delivery_id; that loop now covers maintenance_requests alone.

begin;

drop table if exists public.expenses;
drop table if exists public.emergency_alerts;

commit;
