-- Replacing the driver and/or vehicle of a delivery that is already on the road.
--
-- Until now the only crew write was the assignment, which deletes the previous
-- driver_assignments / truck_assignments rows and pushes the booking back to
-- 'assigned'. Done mid-route (BK-202610-00012, 17 Oct) it erased who had done
-- the pickup and un-started a loaded truck. Assigning is now refused once the
-- driver has started; a crew change on the road is a REPLACEMENT instead:
--
--   * only while the delivery is paused (the driver stopped and said why);
--   * the booking stays 'in_transit' and keeps every trip, stop and proof;
--   * this table keeps the before/after crew, why, and where the hand-over was;
--   * if the load was already on the old vehicle and the vehicle changed, the
--     new driver must confirm the load transfer, with a photo, before any
--     drop-off (transfer_required → transfer_confirmed_at).
--
-- driver_assignments still holds only the CURRENT crew: it is what authorises
-- every driver write, and an old driver kept there would keep writing.

CREATE TABLE IF NOT EXISTS public.crew_replacements (
  replacement_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id     uuid NOT NULL REFERENCES public.bookings(booking_id) ON DELETE CASCADE,
  -- The run the truck was on (NULL when replaced before the first pickup), and
  -- the pause / breakdown report that led to it.
  trip_id        uuid REFERENCES public.booking_trips(trip_id) ON DELETE SET NULL,
  pause_id       uuid REFERENCES public.booking_pauses(pause_id) ON DELETE SET NULL,
  report_id      uuid REFERENCES public.driver_reports(report_id) ON DELETE SET NULL,

  old_driver_id        uuid REFERENCES public.drivers(driver_id) ON DELETE SET NULL,
  old_second_driver_id uuid REFERENCES public.drivers(driver_id) ON DELETE SET NULL,
  old_truck_id         uuid REFERENCES public.trucks(truck_id) ON DELETE SET NULL,
  -- A vendor-supplied vehicle has no trucks row; its plate is kept instead.
  old_vehicle_plate    text,
  new_driver_id        uuid REFERENCES public.drivers(driver_id) ON DELETE SET NULL,
  new_second_driver_id uuid REFERENCES public.drivers(driver_id) ON DELETE SET NULL,
  new_truck_id         uuid REFERENCES public.trucks(truck_id) ON DELETE SET NULL,

  reason_note text NOT NULL,

  -- Where the old vehicle stopped: the pause position, else its last ping.
  handover_latitude  numeric,
  handover_longitude numeric,

  -- The load is on the old vehicle and has to move to the new one.
  transfer_required     boolean NOT NULL DEFAULT false,
  transfer_confirmed_at timestamptz,
  transfer_confirmed_by uuid REFERENCES public.drivers(driver_id) ON DELETE SET NULL,
  transfer_photo_url    text,
  transfer_latitude     numeric,
  transfer_longitude    numeric,
  transfer_accuracy_m   numeric,

  replaced_by      uuid REFERENCES public.users(user_id) ON DELETE SET NULL,
  replaced_by_role text,
  replaced_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_crew_replacements_booking
  ON public.crew_replacements (booking_id, replaced_at);

-- At most one transfer outstanding per booking: the drop-off gate reads it.
CREATE UNIQUE INDEX IF NOT EXISTS uq_crew_replacements_open_transfer
  ON public.crew_replacements (booking_id)
  WHERE transfer_required AND transfer_confirmed_at IS NULL;

-- Same posture as the other booking tables: RLS on, no policy, service-role only.
ALTER TABLE public.crew_replacements ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.crew_replacements FROM anon, authenticated;

-- Who confirmed each loading and each drop-off. driver_assignments only knows
-- the current crew, so once a crew is replaced this is the only place the first
-- driver's work stays attributed to them. NULL on rows from before this column.
ALTER TABLE public.booking_trips
  ADD COLUMN IF NOT EXISTS pickup_confirmed_by uuid REFERENCES public.drivers(driver_id) ON DELETE SET NULL;
ALTER TABLE public.booking_trip_stops
  ADD COLUMN IF NOT EXISTS confirmed_by uuid REFERENCES public.drivers(driver_id) ON DELETE SET NULL;
