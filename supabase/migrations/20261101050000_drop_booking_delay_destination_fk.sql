-- Hotfix (2026-11-01): 20261101020000 gave bookings a SECOND relationship with
-- booking_destinations (bookings.delay_destination_id → booking_destinations,
-- next to booking_destinations.booking_id → bookings). PostgREST then refuses
-- every unnamed bookings <-> booking_destinations embed ("more than one
-- relationship was found"), which broke the client dashboard and every booking
-- read. The column stays (which stop is late); only the constraint goes.
-- Same lesson as 20261101030000: never add a second FK between two tables the
-- code embeds without naming the constraint.

ALTER TABLE public.bookings DROP CONSTRAINT IF EXISTS bookings_delay_destination_id_fkey;
