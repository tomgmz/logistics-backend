-- Routine (preventive) maintenance and odometer tracking for vehicles.
--
-- Until now the only "is this truck fit" record was the BLOWBAGETS check in the
-- yard — nothing knew when a truck was last serviced or how far it had gone.
--
-- 1. SERVICE SCHEDULE, per vehicle. Entered when the vehicle is created (there
--    is no system-wide default on purpose — trucks differ): service every
--    N km OR every N months, whichever comes first, counted from the last
--    service. A vehicle past either limit is OVERDUE and cannot be assigned.
--
-- 2. ODOMETER READINGS, typed by the Fleet Manager with a photo of the dash:
--      pre_trip  — at the BLOWBAGETS inspection before the vehicle goes out
--      post_trip — once the driver has stamped the vehicle back in the lot;
--                  the next BLOWBAGETS is refused until this is recorded
--      initial   — the reading the vehicle was set up with
--      service   — a service recorded at a higher reading than the last one
--    trucks.odometer_km is the latest reading, kept in step by the backend so
--    the fleet list and the due check don't aggregate on every read.
--
-- 3. SERVICE HISTORY. Recording a service restarts both counters from its date
--    and odometer.

ALTER TABLE public.trucks
  ADD COLUMN IF NOT EXISTS service_interval_km      integer CHECK (service_interval_km > 0),
  ADD COLUMN IF NOT EXISTS service_interval_months  integer CHECK (service_interval_months BETWEEN 1 AND 60),
  ADD COLUMN IF NOT EXISTS last_service_at          date,
  ADD COLUMN IF NOT EXISTS last_service_odometer_km integer CHECK (last_service_odometer_km >= 0),
  ADD COLUMN IF NOT EXISTS odometer_km              integer CHECK (odometer_km >= 0),
  ADD COLUMN IF NOT EXISTS odometer_recorded_at     timestamptz;

COMMENT ON COLUMN public.trucks.service_interval_km IS
  'Routine service every N km since the last service. Together with service_interval_months — whichever comes first.';
COMMENT ON COLUMN public.trucks.odometer_km IS
  'Latest odometer reading (km). Mirrors the newest truck_odometer_readings row.';

CREATE TABLE IF NOT EXISTS public.truck_odometer_readings (
  reading_id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  truck_id      uuid NOT NULL REFERENCES public.trucks(truck_id) ON DELETE CASCADE,
  reading_km    integer NOT NULL CHECK (reading_km >= 0),
  kind          varchar(12) NOT NULL CHECK (kind IN ('initial', 'pre_trip', 'post_trip', 'service')),
  -- Cloudinary URL of the dash. Required by the backend for pre/post-trip.
  photo_url     text,
  -- post_trip: the booking the vehicle came back from.
  booking_id    uuid REFERENCES public.bookings(booking_id) ON DELETE SET NULL,
  -- pre_trip: the BLOWBAGETS inspection it was taken at.
  inspection_id uuid REFERENCES public.truck_inspections(inspection_id) ON DELETE SET NULL,
  recorded_by   uuid REFERENCES public.users(user_id) ON DELETE SET NULL,
  recorded_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_truck_odometer_readings_truck
  ON public.truck_odometer_readings (truck_id, recorded_at DESC);

CREATE TABLE IF NOT EXISTS public.truck_services (
  service_id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  truck_id     uuid NOT NULL REFERENCES public.trucks(truck_id) ON DELETE CASCADE,
  serviced_at  date NOT NULL,
  odometer_km  integer NOT NULL CHECK (odometer_km >= 0),
  work_done    text NOT NULL,
  workshop     varchar(200),
  receipt_url  text,
  recorded_by  uuid REFERENCES public.users(user_id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_truck_services_truck
  ON public.truck_services (truck_id, serviced_at DESC);

-- Same posture as the other fleet tables: RLS on, no policy, service-role only.
ALTER TABLE public.truck_odometer_readings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.truck_odometer_readings FROM anon, authenticated;
ALTER TABLE public.truck_services ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.truck_services FROM anon, authenticated;
