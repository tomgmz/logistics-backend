-- Reminders around a paused delivery's continuation (2026-11-01).
--
-- While a delivery is paused (a typhoon, a closed road) the office sets the day
-- and driver call time it continues on (expected_resume_date / _call_time).
-- pause-continuation.scheduler.ts then:
--   * reminds the crew one hour before that call time, and
--   * tells the Operations Manager and Company Administrator when the call time
--     has passed and the delivery is still paused, so a forgotten resume (or a
--     date that slipped again) never sits unnoticed.
--
-- Each is sent once per continuation instant: the columns hold the instant the
-- notice went out for, so changing the date or call time re-arms both.

ALTER TABLE public.booking_pauses
  ADD COLUMN IF NOT EXISTS continuation_reminded_for timestamptz,
  ADD COLUMN IF NOT EXISTS continuation_overdue_for  timestamptz;
