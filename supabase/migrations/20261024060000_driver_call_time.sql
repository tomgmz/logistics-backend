-- The driver's call time: when operations wants the driver at the pickup point,
-- set in the Trip Planner (Company Administrator / Operations Manager).
--
-- Separate from bookings.call_time, which is the client's requested time and
-- stays what the client booked. Null means operations set nothing, and the
-- driver follows the client's call time. It is guidance, not a gate: the driver
-- can still start the delivery earlier.
--
-- driver_call_reminder_for holds the call INSTANT the one-hour-ahead reminder
-- went out for, not when it was sent. Moving the call time makes the stamp stop
-- matching, so the driver is reminded again for the new time with no reset step.
ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS driver_call_time         time,
  ADD COLUMN IF NOT EXISTS driver_call_reminder_for timestamptz;
