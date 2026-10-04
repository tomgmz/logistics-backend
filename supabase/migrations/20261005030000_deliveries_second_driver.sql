-- The second driver on the delivery record, next to driver_id.
--
-- 20261005020000 kept the second driver only in driver_assignments, to avoid a
-- second deliveries -> drivers foreign key while an older API version was still
-- reading this database (an unqualified `drivers(...)` embed becomes ambiguous
-- to PostgREST once there are two). The project is still in development, so the
-- column is added now; the API's one deliveries -> drivers embed is pinned to
-- `drivers!deliveries_driver_id_fkey`.
--
-- What each holds:
--   deliveries.second_driver_id   the delivery's record of who rode along, on
--                                 BOTH paths (a vendor second driver is a
--                                 drivers row too, flagged is_external). Read by
--                                 the crew reservation and "vehicle not back"
--                                 checks, and shown on the assignment.
--   driver_assignments 'second'   what gives the second driver the booking in
--                                 the app (job list, access check, notifications,
--                                 chat). Written together with the column.
ALTER TABLE public.deliveries
  ADD COLUMN IF NOT EXISTS second_driver_id uuid
    REFERENCES public.drivers(driver_id);

ALTER TABLE public.deliveries
  DROP CONSTRAINT IF EXISTS deliveries_second_driver_differs;
ALTER TABLE public.deliveries
  ADD CONSTRAINT deliveries_second_driver_differs
  CHECK (second_driver_id IS NULL OR driver_id IS NULL OR second_driver_id <> driver_id);

CREATE INDEX IF NOT EXISTS idx_deliveries_second_driver_id
  ON public.deliveries (second_driver_id) WHERE second_driver_id IS NOT NULL;

-- Any second driver assigned since 20261005020000.
UPDATE public.deliveries d
   SET second_driver_id = da.driver_id
  FROM public.driver_assignments da
 WHERE da.booking_id = d.booking_id
   AND da.crew_role  = 'second'
   AND d.second_driver_id IS NULL;
