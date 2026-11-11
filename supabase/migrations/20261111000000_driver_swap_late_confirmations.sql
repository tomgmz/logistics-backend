-- Driver swap: late drop-off confirmations from the old main driver's phone.
--
-- booking_crew_swaps: every office swap of main and second driver, with its
-- time, so a confirmation that sat in a phone's offline queue can be judged by
-- WHEN it was done (was this driver the main driver then?), not when it landed.
-- The driving shifts table can't serve: a swap made while the second driver
-- already held the wheel writes no shift row.
--
-- late_confirmations: a late loading (pickup) or drop-off confirmation that failed the automatic evidence
-- check is kept here for the office to Accept (recorded with the driver's own
-- photo and position) or Dismiss (with a reason), instead of being refused and
-- lost. One FK each to bookings, booking_trips and booking_trip_stops; driver / user columns
-- carry no FK on purpose (no second relationship to users or drivers, which
-- would make existing unnamed PostgREST embeds ambiguous; see CLAUDE.md).

CREATE TABLE IF NOT EXISTS public.booking_crew_swaps (
  swap_id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id         uuid NOT NULL REFERENCES public.bookings(booking_id) ON DELETE CASCADE,
  old_lead_driver_id uuid NOT NULL,
  new_lead_driver_id uuid NOT NULL,
  swapped_at         timestamptz NOT NULL DEFAULT now(),
  swapped_by         uuid,
  reason             text
);
CREATE INDEX IF NOT EXISTS booking_crew_swaps_booking_idx ON public.booking_crew_swaps (booking_id, swapped_at);

CREATE TABLE IF NOT EXISTS public.late_confirmations (
  late_id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id       uuid NOT NULL REFERENCES public.bookings(booking_id) ON DELETE CASCADE,
  kind             varchar(10) NOT NULL DEFAULT 'dropoff' CHECK (kind IN ('pickup', 'dropoff')),
  trip_id          uuid NOT NULL REFERENCES public.booking_trips(trip_id) ON DELETE CASCADE,
  trip_stop_id     uuid REFERENCES public.booking_trip_stops(trip_stop_id) ON DELETE CASCADE,  -- null for a pickup
  loaded           jsonb,                 -- a pickup's loaded quantities, as the app sent them
  driver_id        uuid,
  driver_user_id   uuid,
  confirmed_at     timestamptz,           -- when the driver did it (phone time, corrected)
  received_at      timestamptz NOT NULL DEFAULT now(),
  proof_photo_url  text,
  latitude         numeric,
  longitude        numeric,
  accuracy_m       numeric,
  distance_m       numeric,
  override_reason  text,
  reasons          text[] NOT NULL DEFAULT '{}',  -- why it was not accepted automatically
  status           varchar(20) NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'accepted', 'dismissed', 'superseded')),
  resolved_by      uuid,
  resolved_at      timestamptz,
  resolution_note  text,
  last_reminded_at timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS late_confirmations_booking_idx ON public.late_confirmations (booking_id);
CREATE INDEX IF NOT EXISTS late_confirmations_pending_idx ON public.late_confirmations (status) WHERE status = 'pending';
-- One open flag per step and driver: a phone resending the same confirmation
-- doesn't stack flags.
CREATE UNIQUE INDEX IF NOT EXISTS late_confirmations_one_pending_dropoff
  ON public.late_confirmations (trip_stop_id, driver_id) WHERE status = 'pending' AND kind = 'dropoff';
CREATE UNIQUE INDEX IF NOT EXISTS late_confirmations_one_pending_pickup
  ON public.late_confirmations (trip_id, driver_id) WHERE status = 'pending' AND kind = 'pickup';
ALTER TABLE public.late_confirmations ADD CONSTRAINT late_confirmations_kind_ref
  CHECK ((kind = 'dropoff' AND trip_stop_id IS NOT NULL) OR (kind = 'pickup' AND trip_stop_id IS NULL));

ALTER TABLE public.booking_crew_swaps ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.late_confirmations ENABLE ROW LEVEL SECURITY;

-- Swaps made before this table existed: recover them from the staff-recorded
-- driving shifts (best effort; a swap that wrote no shift row can't be recovered).
INSERT INTO public.booking_crew_swaps (booking_id, old_lead_driver_id, new_lead_driver_id, swapped_at, swapped_by, reason)
SELECT s.booking_id,
       prev.driver_id,
       s.driver_id,
       s.started_at,
       s.recorded_by,
       'Recorded before swap history existed'
  FROM public.booking_driving_shifts s
  JOIN LATERAL (
    SELECT p.driver_id FROM public.booking_driving_shifts p
     WHERE p.booking_id = s.booking_id AND p.started_at < s.started_at
     ORDER BY p.started_at DESC LIMIT 1
  ) prev ON true
 WHERE s.source = 'staff'
   AND prev.driver_id <> s.driver_id
   AND NOT EXISTS (SELECT 1 FROM public.booking_crew_swaps x WHERE x.booking_id = s.booking_id AND x.swapped_at = s.started_at);
