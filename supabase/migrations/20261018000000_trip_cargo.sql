-- How much of each cargo line goes on each trip.
--
-- Until now a trip served whole drop-offs: "trip 2 unloads at drop-off 1" said
-- nothing about how much. A drop-off whose goods needed two trips showed the
-- full manifest on both visits, and there was no way to plan "10 of the 20
-- cartons now, the other 10 with drop-offs 2 and 3 on the next run".
--
-- One row per (trip, cargo line): the quantity planned onto that run, and what
-- the driver actually loaded at the pickup. Operations plans it in the trip
-- planner; the driver can load less or more at the pickup, and the difference
-- moves to the following trips (trip.service). A drop-off is delivered once
-- every stop bound for it is done — remainders keep a stop open on a later trip.
--
-- `booking_id` is carried for the live signal and for reading a booking's plan
-- in one query; it always matches the trip's booking.
--
-- Quantities are numeric like booking_cargo_items.quantity. A cargo line with
-- no quantity is planned as one whole unit (planned_qty 1) on a single trip.

CREATE TABLE IF NOT EXISTS public.booking_trip_cargo (
  trip_cargo_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id    uuid NOT NULL REFERENCES public.bookings(booking_id)              ON DELETE CASCADE,
  trip_id       uuid NOT NULL REFERENCES public.booking_trips(trip_id)            ON DELETE CASCADE,
  trip_stop_id  uuid NOT NULL REFERENCES public.booking_trip_stops(trip_stop_id)  ON DELETE CASCADE,
  item_id       uuid NOT NULL REFERENCES public.booking_cargo_items(item_id)      ON DELETE CASCADE,
  planned_qty   numeric NOT NULL CHECK (planned_qty > 0),
  -- Null until the trip is loaded; 0 is "planned but left behind at the pickup".
  loaded_qty    numeric CHECK (loaded_qty >= 0),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT booking_trip_cargo_unique UNIQUE (trip_id, item_id)
);

CREATE INDEX IF NOT EXISTS idx_booking_trip_cargo_booking ON public.booking_trip_cargo (booking_id);
CREATE INDEX IF NOT EXISTS idx_booking_trip_cargo_stop    ON public.booking_trip_cargo (trip_stop_id);
CREATE INDEX IF NOT EXISTS idx_booking_trip_cargo_item    ON public.booking_trip_cargo (item_id);

-- Same posture as the other booking tables: RLS on, no policy, service-role only.
ALTER TABLE public.booking_trip_cargo ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.booking_trip_cargo FROM anon, authenticated;

DROP TRIGGER IF EXISTS live_signal ON public.booking_trip_cargo;
CREATE TRIGGER live_signal AFTER INSERT OR UPDATE OR DELETE ON public.booking_trip_cargo
  FOR EACH ROW EXECUTE FUNCTION public.live_signal_trigger('booking_id', 'live:bookings');

-- Backfill: every existing trip stop carries the full quantity of its drop-off's
-- cargo — exactly what a whole-drop-off stop meant before. Only where the
-- drop-off is served by ONE trip; a drop-off already split across trips had no
-- quantities to begin with and stays without (the app falls back to the whole
-- drop-off's manifest, as before). Loaded trips get loaded_qty = planned.
INSERT INTO public.booking_trip_cargo (booking_id, trip_id, trip_stop_id, item_id, planned_qty, loaded_qty)
SELECT t.booking_id, t.trip_id, s.trip_stop_id, c.item_id,
       COALESCE(NULLIF(c.quantity, 0), 1),
       CASE WHEN t.status IN ('in_transit', 'completed') THEN COALESCE(NULLIF(c.quantity, 0), 1) END
  FROM public.booking_trip_stops s
  JOIN public.booking_trips t        ON t.trip_id = s.trip_id
  JOIN public.booking_cargo_items c  ON c.destination_id = s.destination_id
 WHERE t.status <> 'cancelled'
   AND (SELECT count(*) FROM public.booking_trip_stops s2
          JOIN public.booking_trips t2 ON t2.trip_id = s2.trip_id
         WHERE s2.destination_id = s.destination_id AND t2.status <> 'cancelled') = 1
ON CONFLICT (trip_id, item_id) DO NOTHING;

COMMENT ON TABLE public.booking_trip_cargo IS
  'How much of each cargo line each trip carries: planned by operations, loaded_qty as the driver confirmed at the pickup.';
