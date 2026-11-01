-- A breakdown the driver reports (trip can't continue) waits for the office's
-- decision (2026-11-01). The delivery is NOT paused automatically — only the
-- Company Administrator / Operations Manager pause — but it is flagged here so:
--   * the booking shows "Driver reported a breakdown" with a one-tap
--     "Pause for breakdown" (the note pre-filled) and "Truck is moving again";
--   * breakdown.scheduler.ts reminds the office every 15 min until one of
--     those happens;
--   * delay.scheduler.ts does not send the client a "running late" notice
--     meanwhile (the pause tells them the real reason).
-- Cleared by any pause, the dismissal, or the delivery leaving in_transit.
-- No foreign keys (bookings is already linked to driver_reports elsewhere; a
-- second relationship breaks unnamed embeds).
ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS breakdown_reported_at timestamptz,
  ADD COLUMN IF NOT EXISTS breakdown_report_id   uuid,
  ADD COLUMN IF NOT EXISTS breakdown_note        text,
  ADD COLUMN IF NOT EXISTS breakdown_reminded_at timestamptz;
