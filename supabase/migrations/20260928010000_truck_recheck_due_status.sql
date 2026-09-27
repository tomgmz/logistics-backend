-- A vehicle back from a job is not ready for the next one until the Fleet
-- Manager has run BLOWBAGETS on it again. Assignment already refused it (the
-- pass expires on return — assertInspectedSinceLastReturn), but its status
-- still read 'available', which is what everyone looking at the fleet sees.
--
-- 'recheck_due' is set when the driver confirms the vehicle is back in the
-- parking lot, and cleared back to 'available' by the next passing inspection.

ALTER TABLE public.trucks DROP CONSTRAINT IF EXISTS trucks_status_check;

ALTER TABLE public.trucks ADD CONSTRAINT trucks_status_check
  CHECK (status IN ('available', 'recheck_due', 'in_use', 'under_maintenance', 'inactive', 'archived'));

-- Vehicles already back and still waiting on their re-check.
UPDATE public.trucks t
   SET status = 'recheck_due', updated_at = now()
 WHERE t.status = 'available'
   AND EXISTS (
     SELECT 1
       FROM public.deliveries d
       JOIN public.bookings b ON b.booking_id = d.booking_id
      WHERE d.truck_id = t.truck_id
        AND b.fleet_return_at IS NOT NULL
        AND b.fleet_return_at > COALESCE(
              (SELECT max(i.inspected_at) FROM public.truck_inspections i WHERE i.truck_id = t.truck_id),
              '-infinity'::timestamptz)
   );
