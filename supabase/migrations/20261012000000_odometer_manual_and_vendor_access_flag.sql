-- Two small changes, both additive.
--
-- 1. The odometer is no longer taken with the BLOWBAGETS inspection. It is set at
--    creation, owed when the vehicle is back from a job, and otherwise updated
--    whenever the Fleet Manager or Company Administrator reads it (for example a
--    multi-trip run paused for weather, with the vehicle back in the parking lot
--    in between). Those ad-hoc readings are kind 'manual'. 'pre_trip' stays for
--    the readings already taken with an inspection.
--
-- 2. A vendor driver's app access is revoked automatically once the booking they
--    drove is completed (client confirmation, or the 3-day auto-complete). The
--    account is flagged with when, why and for which booking, so Driver
--    Management can show it. A manual revoke writes the same flag; restoring the
--    account clears it.

ALTER TABLE public.truck_odometer_readings
  DROP CONSTRAINT IF EXISTS truck_odometer_readings_kind_check;
ALTER TABLE public.truck_odometer_readings
  ADD CONSTRAINT truck_odometer_readings_kind_check
  CHECK (kind IN ('initial', 'pre_trip', 'post_trip', 'service', 'manual'));

ALTER TABLE public.drivers
  ADD COLUMN IF NOT EXISTS access_revoked_at         timestamptz,
  ADD COLUMN IF NOT EXISTS access_revoked_reason     text,
  -- Deliberately no foreign key: a drivers -> bookings FK would add a second
  -- path between the two tables and make existing PostgREST embeds ambiguous.
  -- It is a pointer for the flag's text, nothing joins on it.
  ADD COLUMN IF NOT EXISTS access_revoked_booking_id uuid;
