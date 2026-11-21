-- Late start (2026-11-21): a booking still Assigned 15 minutes after its call
-- time (the driver call time operations set, or the client's call time when
-- none was set). Like the Delayed mark, a flag on the booking, never a status.
-- late-start.scheduler.ts sets and clears it.
--
-- late_start_for:          the call INSTANT the booking was flagged late for.
--   Null = not late. A new call time stops it matching, so the mark clears and
--   the new time gets its own cycle (same idea as driver_call_reminder_for).
-- late_start_reminded_at:  when the Operations Manager and Company
--   Administrator were last told; the 30-minute repeats are timed from it.
-- late_start_client_for:   the call instant the client was told the first
--   drop-off is at risk; once per call instant.
ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS late_start_for         timestamptz,
  ADD COLUMN IF NOT EXISTS late_start_reminded_at timestamptz,
  ADD COLUMN IF NOT EXISTS late_start_client_for  timestamptz;
