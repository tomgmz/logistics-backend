-- The driver a vehicle belongs to.
--
-- Until now a booking picked a driver and a vehicle independently, and nothing
-- recorded that in the yard they are a pair: this truck is that driver's truck.
-- Operations knew it, the system did not, so every assignment re-answered a
-- question the fleet had already settled.
--
-- This is deliberately a REGULAR pairing, not a reservation. It says who
-- normally drives the vehicle; it is not what stops a truck being double-booked
-- (`fleet_return_at` and the BLOWBAGETS check do that, in
-- fleet-availability.service). Keeping the two apart matters: a pairing that
-- also gated assignment would strand a vehicle every time its driver went on
-- leave, and the fleet manager would have to break the pairing to get the truck
-- moving again.
ALTER TABLE public.trucks
  ADD COLUMN IF NOT EXISTS assigned_driver_id uuid
    REFERENCES public.drivers(driver_id) ON DELETE SET NULL;

-- ON DELETE SET NULL rather than CASCADE: losing a driver must never delete a
-- vehicle. The truck simply goes back to having no regular driver.

-- One truck per driver, and one driver per truck. A driver cannot be the regular
-- driver of two vehicles at once, which is what the fleet means by "their truck".
-- Partial, so any number of trucks may sit unpaired.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_trucks_assigned_driver
  ON public.trucks (assigned_driver_id)
  WHERE assigned_driver_id IS NOT NULL;

COMMENT ON COLUMN public.trucks.assigned_driver_id IS
  'The driver this vehicle is normally crewed with, set by the fleet manager in Vehicle Management. A default for assignment, not a lock: booking assignment still checks the calendar, the BLOWBAGETS inspection and the fleet return.';
