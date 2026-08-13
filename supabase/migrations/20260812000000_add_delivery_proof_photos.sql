-- Proof of pickup / proof of delivery.
--
-- The driver must photograph every stop before it can be confirmed from the
-- navigation map: one photo for the pickup, one per drop-off. Photos are stored
-- in Cloudinary (same as the rest of the app's images) and only the URL and the
-- capture timestamp are kept here.
--
-- Nullable on purpose: bookings that predate this requirement have no photos,
-- and the not-null rule is enforced by the driver confirmation endpoints rather
-- than by the column, so admin corrections stay possible.
-- Backend writes/reads with the service-role key, so no RLS policy is added.

-- 1. Pickup proof lives on the booking (a booking has exactly one origin).
ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS pickup_proof_photo_url text,
  ADD COLUMN IF NOT EXISTS pickup_proof_at        timestamptz;

-- 2. Delivery proof lives on each drop-off.
ALTER TABLE public.booking_destinations
  ADD COLUMN IF NOT EXISTS proof_photo_url text,
  ADD COLUMN IF NOT EXISTS proof_at        timestamptz;

-- 3. At most three drop-offs per booking. The API and the client wizard both
--    enforce this; the trigger is the backstop for direct/manual inserts.
CREATE OR REPLACE FUNCTION public.enforce_max_destinations_per_booking()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  destination_count integer;
BEGIN
  SELECT count(*) INTO destination_count
  FROM public.booking_destinations
  WHERE booking_id = NEW.booking_id;

  IF destination_count > 3 THEN
    RAISE EXCEPTION 'A booking can have at most 3 drop-offs (booking_id: %)', NEW.booking_id;
  END IF;

  RETURN NULL;
END;
$$;

-- A deferred constraint trigger: the count is checked at COMMIT, so inserting a
-- booking's three destinations in one transaction passes, while a fourth fails.
DROP TRIGGER IF EXISTS trg_max_destinations_per_booking ON public.booking_destinations;
CREATE CONSTRAINT TRIGGER trg_max_destinations_per_booking
  AFTER INSERT OR UPDATE OF booking_id ON public.booking_destinations
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_max_destinations_per_booking();
