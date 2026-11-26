-- Delayed = the truck is not at the pick-up point by the client's pick-up time
-- (user 2026-11-26). The planned arrival per drop-off is no longer computed or
-- shown; drop-offs have the live ETA only.
--
-- bookings.pickup_arrived_at: when the truck first reached the pick-up point
-- for trip 1 (the phone's arrival step, the loading proof, or a GPS fix within
-- 100 m of it), stamped by delay.scheduler. It ends the Delayed check and is
-- what on-time pick-up is measured from.
--
-- driver_locations.eta_pickup_at: the live ETA to the pick-up point while the
-- truck is on its way there (eta.service), so a late truck's new time can be
-- given.
--
-- The planned_* columns on booking_trips / booking_trip_stops and
-- bookings.estimated_delivery are left in place (reserved, no longer written).
-- No foreign keys added.

ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS pickup_arrived_at timestamptz;

ALTER TABLE public.driver_locations
  ADD COLUMN IF NOT EXISTS eta_pickup_at timestamptz;

COMMENT ON COLUMN public.bookings.pickup_arrived_at IS
  'First arrival at the pick-up point (trip 1): arrival step, loading proof or GPS within 100 m. Set by delay.scheduler.';
COMMENT ON COLUMN public.driver_locations.eta_pickup_at IS
  'Live ETA to the pick-up point while the truck is heading there (null once loaded).';

-- Old planned figures would read as current: clear them.
UPDATE public.booking_trip_stops SET planned_arrival_at = NULL WHERE planned_arrival_at IS NOT NULL;
UPDATE public.booking_trips
   SET planned_departure_at = NULL, planned_arrival_at = NULL, planned_return_at = NULL
 WHERE planned_departure_at IS NOT NULL OR planned_arrival_at IS NOT NULL OR planned_return_at IS NOT NULL;
UPDATE public.bookings SET estimated_delivery = NULL
 WHERE estimated_delivery IS NOT NULL AND status IN ('approved', 'assigned', 'in_transit');
