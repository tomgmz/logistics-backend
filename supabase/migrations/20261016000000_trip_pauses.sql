-- The driver pauses a delivery and says why.
--
-- Things stop a truck that are nobody's fault and not an emergency: a typhoon
-- signal, a breakdown waiting for a mechanic, a warehouse that turned out to be
-- closed. Until now the only way to say so was an SOS report or a phone call,
-- and the web showed the booking as plainly "in transit" while the truck sat on
-- the shoulder for three hours.
--
-- Two places hold it, on purpose:
--
--   * booking_pauses — the history. One row per pause, closed when it ends, so
--     ops can read back every stop and how long it lasted.
--   * bookings.paused_at / pause_reason / pause_note — the pause in force NOW,
--     NULL when the truck is moving. Every booking list already reads the
--     bookings row and already refreshes on live:bookings, so the status shows
--     up everywhere without each screen joining the history.
--
-- A pause is not a booking status. The booking stays 'assigned' or
-- 'in_transit' underneath it: pings, stop confirmations and the offline queue
-- all key off that status, and a new one would have to be taught to every one
-- of them. A pause is a flag on top.

CREATE TABLE IF NOT EXISTS public.booking_pauses (
  pause_id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id uuid NOT NULL REFERENCES public.bookings(booking_id) ON DELETE CASCADE,
  -- The run the truck was on, when it was on one. NULL before the first pickup
  -- (e.g. the pickup point itself was closed).
  trip_id    uuid REFERENCES public.booking_trips(trip_id) ON DELETE SET NULL,

  -- What the client sees. The note below is staff-only.
  reason varchar(30) NOT NULL
    CHECK (reason IN ('weather', 'vehicle_breakdown', 'pickup_closed', 'dropoff_closed', 'road_closed', 'other')),
  note   text NOT NULL,

  paused_by uuid REFERENCES public.users(user_id) ON DELETE SET NULL,
  -- When the driver pressed it, as the phone recorded it. A pause sent from a
  -- dead zone can reach the server hours later.
  paused_at timestamptz NOT NULL DEFAULT now(),

  -- Where the truck was.
  latitude   numeric,
  longitude  numeric,
  accuracy_m numeric,

  -- A breakdown pause also files a driver report, so the Fleet Manager has it
  -- in their queue. This is that report.
  report_id uuid REFERENCES public.driver_reports(report_id) ON DELETE SET NULL,

  -- NULL while the pause is in force.
  resumed_at   timestamptz,
  resumed_by   uuid REFERENCES public.users(user_id) ON DELETE SET NULL,
  -- 'driver' — the driver pressed Resume
  -- 'staff'  — Operations or the Company Administrator ended it from the web
  -- 'auto'   — the driver confirmed a pickup or drop-off, which means the truck
  --            is plainly moving again
  resumed_via  varchar(10) CHECK (resumed_via IN ('driver', 'staff', 'auto')),
  resume_note  text,

  created_at timestamptz NOT NULL DEFAULT now()
);

-- At most one pause in force per booking. The service relies on this to make a
-- retried pause from the offline queue harmless.
CREATE UNIQUE INDEX IF NOT EXISTS uq_booking_pauses_open
  ON public.booking_pauses (booking_id)
  WHERE resumed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_booking_pauses_booking
  ON public.booking_pauses (booking_id, paused_at DESC);

-- Same posture as the other booking tables: RLS on, no policy, service-role only.
ALTER TABLE public.booking_pauses ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.booking_pauses FROM anon, authenticated;

ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS paused_at    timestamptz,
  ADD COLUMN IF NOT EXISTS pause_reason varchar(30),
  ADD COLUMN IF NOT EXISTS pause_note   text;

-- History changes refresh the same screens the booking does.
DROP TRIGGER IF EXISTS live_signal ON public.booking_pauses;
CREATE TRIGGER live_signal AFTER INSERT OR UPDATE OR DELETE ON public.booking_pauses
  FOR EACH ROW EXECUTE FUNCTION public.live_signal_trigger('booking_id', 'live:bookings');

COMMENT ON TABLE public.booking_pauses IS
  'Every time a driver paused a delivery (weather, breakdown, closed stop…), with the reason, note, position and when it ended.';
COMMENT ON COLUMN public.bookings.paused_at IS
  'Set while the delivery is paused (copy of the open booking_pauses row); NULL when the truck is moving.';
COMMENT ON COLUMN public.bookings.pause_reason IS
  'Reason category of the pause in force — the part the client is shown.';
COMMENT ON COLUMN public.bookings.pause_note IS
  'Driver''s note on the pause in force. Staff only; never sent to the client.';
