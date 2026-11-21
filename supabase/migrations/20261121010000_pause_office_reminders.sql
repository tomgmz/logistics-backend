-- Reminders that repeat and go higher up for a paused delivery (2026-11-21).
--
-- Only the Operations Manager and the Company Administrator can end a pause, and
-- while it lasts the driver's stop confirmations are held. A pause the office
-- forgets therefore leaves the driver waiting. pause-continuation.scheduler.ts now:
--   * repeats the "still paused" notice every 30 min once the continuation call
--     time is 15 min past (it was sent once only);
--   * reminds the office about a pause with NO continuation date, 2 h after it
--     started and then every morning at 7:00 (Manila);
--   * tells the General Manager once when either goes unanswered: 2 h past the
--     call time, or 24 h paused with no date.
--
-- office_reminded_at: when the office was last reminded about this pause (any
--   of the reminders above); the repeats are timed from it.
-- gm_escalated_for:   the instant the GM notice was sent for (the continuation
--   instant, or paused_at for a pause with no date). Setting a new date stops it
--   matching, so the new date gets its own cycle.

ALTER TABLE public.booking_pauses
  ADD COLUMN IF NOT EXISTS office_reminded_at timestamptz,
  ADD COLUMN IF NOT EXISTS gm_escalated_for   timestamptz;
