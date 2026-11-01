-- Three loophole fixes (2026-11-01). Apply BEFORE deploying the backend that
-- reads them.

-- ── 1. License renewal ───────────────────────────────────────────────────────
-- A replaced license is scanned on the server and checked against the driver
-- (same license number, same name), and staff confirm it against LTO's LTMS.
-- The license codes are kept so a renewal that drops a code is noticed.
ALTER TABLE public.drivers
  ADD COLUMN IF NOT EXISTS dl_codes            text[],
  ADD COLUMN IF NOT EXISTS restriction_codes   text[],
  ADD COLUMN IF NOT EXISTS license_verified_at timestamptz,
  ADD COLUMN IF NOT EXISTS license_verified_by uuid REFERENCES public.users(user_id) ON DELETE SET NULL;

-- The license a driver held before each change: never overwritten, so an old
-- card (or a wrong upload) can always be looked at again.
CREATE TABLE IF NOT EXISTS public.driver_license_history (
  history_id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id         uuid NOT NULL REFERENCES public.drivers(driver_id) ON DELETE CASCADE,
  license_number    varchar(30),
  license_expiry    date,
  license_image_url text,
  dl_codes          text[],
  restriction_codes text[],
  verified_at       timestamptz,
  verified_by       uuid REFERENCES public.users(user_id) ON DELETE SET NULL,
  -- The change that replaced it.
  replaced_at       timestamptz NOT NULL DEFAULT now(),
  replaced_by       uuid REFERENCES public.users(user_id) ON DELETE SET NULL,
  -- Why a mismatch (other number, other name, earlier expiry, lost code) was accepted.
  change_note       text,
  -- What the server read off the new image, for the record.
  scanned           jsonb
);
CREATE INDEX IF NOT EXISTS idx_driver_license_history_driver
  ON public.driver_license_history (driver_id, replaced_at DESC);
ALTER TABLE public.driver_license_history ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.driver_license_history FROM anon, authenticated;

-- ── 2. Delayed delivery ──────────────────────────────────────────────────────
-- A flag on the booking, like a pause: not a status. delay.scheduler.ts sets it
-- when the next stop's live ETA (or the clock) runs 15+ min past its planned
-- window, and clears it once back inside the window.
ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS delayed_since          timestamptz,
  ADD COLUMN IF NOT EXISTS delay_minutes          integer,
  ADD COLUMN IF NOT EXISTS delay_expected_at      timestamptz,
  ADD COLUMN IF NOT EXISTS delay_destination_id   uuid REFERENCES public.booking_destinations(destination_id) ON DELETE SET NULL,
  -- The lateness the client was last told about; re-told after 30 more minutes.
  ADD COLUMN IF NOT EXISTS delay_notified_minutes integer,
  -- For on-time reporting: kept after the delay clears.
  ADD COLUMN IF NOT EXISTS delay_max_minutes      integer;

-- ── 3. Who is driving ────────────────────────────────────────────────────────
-- The truck has two drivers on a long run and they swap at the wheel. Each row
-- is one stretch at the wheel; the open one (ended_at NULL) is the driver now.
CREATE TABLE IF NOT EXISTS public.booking_driving_shifts (
  shift_id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id  uuid NOT NULL REFERENCES public.bookings(booking_id) ON DELETE CASCADE,
  driver_id   uuid NOT NULL REFERENCES public.drivers(driver_id) ON DELETE CASCADE,
  started_at  timestamptz NOT NULL,
  ended_at    timestamptz,
  -- 'start' (Start Navigation), 'switch' (a crew member took the wheel in the
  -- app), 'staff' (the office recorded it, e.g. after swapping crew roles).
  source      varchar(10) NOT NULL CHECK (source IN ('start', 'switch', 'staff')),
  recorded_by uuid REFERENCES public.users(user_id) ON DELETE SET NULL,
  latitude    numeric,
  longitude   numeric,
  clock_adjusted boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_booking_driving_shifts_booking
  ON public.booking_driving_shifts (booking_id, started_at);
-- One driver at the wheel at a time.
CREATE UNIQUE INDEX IF NOT EXISTS uq_booking_driving_shifts_open
  ON public.booking_driving_shifts (booking_id) WHERE ended_at IS NULL;
ALTER TABLE public.booking_driving_shifts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.booking_driving_shifts FROM anon, authenticated;
