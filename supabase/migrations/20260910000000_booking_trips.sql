-- One vehicle, several trips.
--
-- A booking used to be one truckload: assign a truck, confirm the pickup once,
-- work down the drop-offs, done. That is why the pickup proof lives in columns
-- ON THE BOOKING — there was only ever one pickup to prove.
--
-- Real loads do not fit that. When the cargo is larger than the body, the same
-- truck shuttles: load at origin, run to a drop-off, come back empty, load
-- again, run again. The vehicle never changes; the number of runs does. So the
-- pickup proof stops being a property of the booking and becomes a property of
-- a TRIP, and the drop-offs a trip serves become an explicit plan rather than
-- "all of them, once".
--
-- Two tables, because the two relationships are genuinely many-to-many:
--   * a trip may serve several drop-offs (a run that unloads at two bays), and
--   * a drop-off may be served across several trips (a bay too big for one load)
-- so neither a trip_id on booking_destinations nor a destination_id on
-- booking_trips can express the plan. booking_trip_stops is the join, and it —
-- not booking_destinations — is where a driver's per-visit proof now lands.
--
-- booking_destinations.status stays, and stays authoritative for "is this bay
-- finished": it is what the client, the web app and every existing query read.
-- It is now DERIVED — a destination is delivered once no trip stop of its own
-- is outstanding — and the service that confirms a stop is what rolls it up.

/* ── The runs ─────────────────────────────────────────────────────────────── */

CREATE TABLE IF NOT EXISTS public.booking_trips (
  trip_id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id   uuid NOT NULL REFERENCES public.bookings(booking_id) ON DELETE CASCADE,

  -- 1..N in the order the truck runs them. Ops plans the count when it crews
  -- the booking; the driver works through them in this order and cannot skip.
  trip_number  integer NOT NULL CHECK (trip_number > 0),

  -- 'pending'    — not yet loaded
  -- 'in_transit' — pickup confirmed for THIS trip, truck is out
  -- 'completed'  — every stop on this trip confirmed
  -- 'cancelled'  — planned but not needed (the load fit in fewer runs)
  status varchar(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'in_transit', 'completed', 'cancelled')),

  -- The proof the driver takes AT THE ORIGIN for this run. Every trip needs its
  -- own: the whole point is that the truck is loaded more than once, and a
  -- single photo cannot evidence the second loading.
  pickup_proof_photo_url       text,
  pickup_proof_at              timestamptz,
  pickup_proof_latitude        numeric,
  pickup_proof_longitude       numeric,
  pickup_proof_accuracy_m      numeric,
  pickup_proof_distance_m      numeric,
  pickup_proof_override_reason text,

  notes      text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT booking_trips_number_unique UNIQUE (booking_id, trip_number)
);

CREATE INDEX IF NOT EXISTS idx_booking_trips_booking_id
  ON public.booking_trips (booking_id, trip_number);

-- Forced pickup confirmations are reviewed by operations and are rare by
-- design, so a partial index keeps them cheap to find. Same shape as the
-- booking-level index this replaces.
CREATE INDEX IF NOT EXISTS idx_booking_trips_pickup_proof_override
  ON public.booking_trips (trip_id)
  WHERE pickup_proof_override_reason IS NOT NULL;

/* ── Which drop-offs each run serves ──────────────────────────────────────── */

CREATE TABLE IF NOT EXISTS public.booking_trip_stops (
  trip_stop_id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id        uuid NOT NULL REFERENCES public.booking_trips(trip_id) ON DELETE CASCADE,
  destination_id uuid NOT NULL REFERENCES public.booking_destinations(destination_id) ON DELETE CASCADE,

  -- Order of the unload points WITHIN this trip. Independent of the
  -- destination's own sequence_order, which orders the bays across the booking.
  sequence_order integer NOT NULL CHECK (sequence_order > 0),

  status varchar(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'delivered', 'failed')),
  delivered_at timestamptz,

  -- Per-visit proof. booking_destinations keeps its own proof columns for the
  -- last visit that closed it, so existing readers still see a photo; this is
  -- the full trail, one row per time the truck actually pulled up.
  proof_photo_url       text,
  proof_at              timestamptz,
  proof_latitude        numeric,
  proof_longitude       numeric,
  proof_accuracy_m      numeric,
  proof_distance_m      numeric,
  proof_override_reason text,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  -- A trip visits a given bay once. Two loads for the same bay are two trips,
  -- which is exactly what the shuttle is.
  CONSTRAINT booking_trip_stops_unique UNIQUE (trip_id, destination_id)
);

CREATE INDEX IF NOT EXISTS idx_booking_trip_stops_trip_id
  ON public.booking_trip_stops (trip_id, sequence_order);

CREATE INDEX IF NOT EXISTS idx_booking_trip_stops_destination_id
  ON public.booking_trip_stops (destination_id);

/* ── Back at the yard ─────────────────────────────────────────────────────── */

-- The job is not over when the last box is off the truck; it is over when the
-- truck is back in the 8338 lot. Confirmed ONCE, after the final drop-off —
-- the returns between trips are implied by the next trip's pickup proof and
-- are not separately confirmed.
ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS fleet_return_at        timestamptz,
  ADD COLUMN IF NOT EXISTS fleet_return_latitude  numeric,
  ADD COLUMN IF NOT EXISTS fleet_return_longitude numeric;

/* ── Backfill ─────────────────────────────────────────────────────────────── */

-- Every existing booking was one truckload, so it becomes exactly one trip
-- serving every drop-off in its own order — the shape that reproduces today's
-- behaviour. The booking's existing pickup proof moves onto that trip, and each
-- destination's existing proof onto its trip stop, so history reads back
-- through the new tables rather than dead-ending at the old columns.
--
-- The old bookings.pickup_proof_* columns are deliberately LEFT IN PLACE and
-- still written for trip 1: the web app, the billing PDFs and the client-facing
-- booking detail all read them, and breaking those is not this migration's job.

INSERT INTO public.booking_trips (
  booking_id, trip_number, status,
  pickup_proof_photo_url, pickup_proof_at,
  pickup_proof_latitude, pickup_proof_longitude,
  pickup_proof_accuracy_m, pickup_proof_distance_m, pickup_proof_override_reason,
  created_at
)
SELECT
  b.booking_id,
  1,
  CASE
    WHEN b.status = 'completed'            THEN 'completed'
    WHEN b.pickup_proof_photo_url IS NOT NULL THEN 'in_transit'
    ELSE 'pending'
  END,
  b.pickup_proof_photo_url, b.pickup_proof_at,
  b.pickup_proof_latitude, b.pickup_proof_longitude,
  b.pickup_proof_accuracy_m, b.pickup_proof_distance_m, b.pickup_proof_override_reason,
  b.created_at
FROM public.bookings b
WHERE NOT EXISTS (
  SELECT 1 FROM public.booking_trips t WHERE t.booking_id = b.booking_id
);

INSERT INTO public.booking_trip_stops (
  trip_id, destination_id, sequence_order, status, delivered_at,
  proof_photo_url, proof_at,
  proof_latitude, proof_longitude,
  proof_accuracy_m, proof_distance_m, proof_override_reason
)
SELECT
  t.trip_id,
  d.destination_id,
  d.sequence_order,
  CASE WHEN d.status IN ('delivered', 'failed') THEN d.status ELSE 'pending' END,
  d.delivered_at,
  d.proof_photo_url, d.proof_at,
  d.proof_latitude, d.proof_longitude,
  d.proof_accuracy_m, d.proof_distance_m, d.proof_override_reason
FROM public.booking_destinations d
JOIN public.booking_trips t
  ON t.booking_id = d.booking_id AND t.trip_number = 1
WHERE NOT EXISTS (
  SELECT 1 FROM public.booking_trip_stops s WHERE s.destination_id = d.destination_id
);

/* ── Access ───────────────────────────────────────────────────────────────── */

-- Same posture as the other booking tables (see
-- 20260901050000_lock_down_booking_tables): RLS on with no policy, so nothing
-- reaches these through the anon/authenticated keys. Every read and write goes
-- through the API on the service role.
ALTER TABLE public.booking_trips      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.booking_trip_stops ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.booking_trips      FROM anon, authenticated;
REVOKE ALL ON public.booking_trip_stops FROM anon, authenticated;

COMMENT ON TABLE public.booking_trips IS
  'One run of the assigned vehicle for a booking. A booking whose cargo exceeds the body is several trips of the SAME truck, planned by operations at assignment time; each carries its own proof of loading.';
COMMENT ON TABLE public.booking_trip_stops IS
  'Which drop-offs a trip unloads at, and the proof the driver took at each visit. A drop-off served over two loads has a row on each trip.';
COMMENT ON COLUMN public.bookings.fleet_return_at IS
  'When the driver confirmed the vehicle was back in the company parking lot. Set once, after the final drop-off.';
