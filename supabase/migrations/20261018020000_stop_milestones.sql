-- The times at each stop: when the truck reached the parking, docked, started
-- loading or unloading, and left.
--
-- FMCG warehouses run on these: detention and waiting time are argued over
-- them, and until now the only times on record were the proof confirmations
-- (booking_trips.pickup_proof_at = loading finished; booking_trip_stops.
-- delivered_at = unloading finished). The finishing time stays exactly that —
-- the confirmation with its photo — and this table holds the four taps around
-- it, for the loading (trip_stop_id NULL) and for each drop-off of each trip:
--
--   arrived_parking → docked → started → [finished = proof] → departed
--
-- The driver taps them on the phone. The time is the server's when the tap
-- reaches it straight away; a tap queued offline keeps the phone's time, which
-- the app has already corrected to the server's clock, bounded by the service
-- (never in the future, never before the step before it). Operations can fill
-- in or correct one from the web with a reason; the original stays in the
-- audit log.

CREATE TABLE IF NOT EXISTS public.stop_milestones (
  milestone_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id   uuid NOT NULL REFERENCES public.bookings(booking_id)              ON DELETE CASCADE,
  trip_id      uuid NOT NULL REFERENCES public.booking_trips(trip_id)            ON DELETE CASCADE,
  -- NULL for the loading at the origin; the drop-off visit otherwise.
  trip_stop_id uuid          REFERENCES public.booking_trip_stops(trip_stop_id)  ON DELETE CASCADE,
  stage varchar(20) NOT NULL
    CHECK (stage IN ('arrived_parking', 'docked', 'started', 'departed')),
  at    timestamptz NOT NULL,

  -- Who put it there: the driver's tap, or the office filling / fixing it.
  source varchar(10) NOT NULL CHECK (source IN ('driver', 'staff')),
  driver_id  uuid REFERENCES public.drivers(driver_id) ON DELETE SET NULL,
  -- What the phone said, and when the server received it (driver taps).
  device_at   timestamptz,
  received_at timestamptz NOT NULL DEFAULT now(),
  latitude    numeric,
  longitude   numeric,
  accuracy_m  numeric,

  -- A staff fill-in or correction.
  corrected_by    uuid REFERENCES public.users(user_id) ON DELETE SET NULL,
  corrected_at    timestamptz,
  correction_note text,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- One of each step per stop visit. The driver's first tap wins (queue retries
-- are harmless); a correction updates the row.
CREATE UNIQUE INDEX IF NOT EXISTS uq_stop_milestones_step
  ON public.stop_milestones (trip_id, COALESCE(trip_stop_id, '00000000-0000-0000-0000-000000000000'::uuid), stage);
CREATE INDEX IF NOT EXISTS idx_stop_milestones_booking
  ON public.stop_milestones (booking_id);

-- Same posture as the other booking tables: RLS on, no policy, service-role only.
ALTER TABLE public.stop_milestones ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.stop_milestones FROM anon, authenticated;

-- Every screen showing the booking refreshes when a time lands.
DROP TRIGGER IF EXISTS live_signal ON public.stop_milestones;
CREATE TRIGGER live_signal AFTER INSERT OR UPDATE OR DELETE ON public.stop_milestones
  FOR EACH ROW EXECUTE FUNCTION public.live_signal_trigger('booking_id', 'live:bookings');

COMMENT ON TABLE public.stop_milestones IS
  'Arrival at parking, docking, start and departure at the loading (trip_stop_id NULL) and at each drop-off visit. The finish is the proof confirmation.';
