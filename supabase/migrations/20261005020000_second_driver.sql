-- An optional second driver per booking.
--
-- driver_assignments is the table the whole driver-facing side already reads —
-- the driver's job list, the per-booking access check, notification recipients,
-- the booking chat — and every one of those reads already copes with more than
-- one row per booking. What held it to one driver was the unique index on
-- booking_id. It becomes "one row per driver per booking", with a role so the
-- MAIN driver stays unambiguous: they run the trip in the app (pickup, stops,
-- proof photos, live location, vehicle return). The second driver sees the
-- booking and its stops; their phone never sends a position, because
-- driver_locations is one row per driver and the client's map reads one row per
-- booking.
--
-- The second driver lives ONLY here, not as a column on deliveries. A second
-- foreign key from deliveries to drivers would make every existing
-- `deliveries -> drivers(...)` embed ambiguous to PostgREST, which would break
-- the API version already running against this database the moment this
-- migration landed. deliveries.driver_id stays the main company driver.
ALTER TABLE public.driver_assignments
  ADD COLUMN IF NOT EXISTS crew_role text NOT NULL DEFAULT 'lead';

ALTER TABLE public.driver_assignments
  DROP CONSTRAINT IF EXISTS driver_assignments_crew_role_check;
ALTER TABLE public.driver_assignments
  ADD CONSTRAINT driver_assignments_crew_role_check CHECK (crew_role IN ('lead', 'second'));

ALTER TABLE public.driver_assignments
  DROP CONSTRAINT IF EXISTS uq_driver_assignment_booking;
DROP INDEX IF EXISTS public.uq_driver_assignment_booking;

-- At most one of each role per booking, and never the same driver twice.
CREATE UNIQUE INDEX IF NOT EXISTS uq_driver_assignment_booking_role
  ON public.driver_assignments (booking_id, crew_role);
CREATE UNIQUE INDEX IF NOT EXISTS uq_driver_assignment_booking_driver
  ON public.driver_assignments (booking_id, driver_id);
