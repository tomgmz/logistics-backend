-- Crew rule by distance: a second driver is required on a booking whose route
-- is over 30 km, and not used at or under it. A short run takes an optional
-- helper instead, recorded for information only.
--
-- bookings.route_distance_m      the route's road distance by Google, pickup to
--                                every drop-off in sequence, one way. A cache:
-- bookings.route_distance_key    the coordinates it was measured over. When the
--                                pickup or a drop-off moves (or a stop is added,
--                                removed or re-ordered) the key no longer matches
--                                and the distance is measured again.
--
-- deliveries.helper_name         free text. Not a user and not a driver: no app
--                                access, no reservation, no notifications.
ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS route_distance_m   integer,
  ADD COLUMN IF NOT EXISTS route_distance_key text;

ALTER TABLE public.deliveries
  ADD COLUMN IF NOT EXISTS helper_name text;

ALTER TABLE public.deliveries
  DROP CONSTRAINT IF EXISTS deliveries_helper_name_length;
ALTER TABLE public.deliveries
  ADD CONSTRAINT deliveries_helper_name_length
  CHECK (helper_name IS NULL OR char_length(helper_name) BETWEEN 1 AND 120);

COMMENT ON COLUMN public.bookings.route_distance_m IS
  'Road distance in metres, pickup to every drop-off in sequence, one way. Cached; valid only while route_distance_key matches the current coordinates.';
COMMENT ON COLUMN public.bookings.route_distance_key IS
  'The coordinates route_distance_m was measured over. A mismatch means re-measure.';
COMMENT ON COLUMN public.deliveries.helper_name IS
  'Optional helper on a route of 30 km or less. Information only — not a user, never reserved or notified.';
