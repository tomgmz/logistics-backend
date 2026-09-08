-- Booking integrity and the indexes the booking screens actually sort and join on.
--
-- Three separate problems, all of them latent while the table is small and all
-- of them certain to bite as it fills:
--
--  1. Nothing stopped two drop-offs on the same booking sharing a
--     `sequence_order`. The API checked for duplicates BEFORE route
--     optimisation reordered the stops, and the optimiser matched stops back by
--     address string — so two deliveries to the same address collapsed onto one
--     number and the driver's stop order became ambiguous.
--  2. `booking_cargo_items` was the only child of `bookings` without an index on
--     `booking_id`, so every booking detail read sequentially scanned it.
--  3. The booking list sorts by `created_at DESC`, filtered by `client_id` for a
--     client caller, with no index supporting either.

-- 1. One stop per position, per booking.
ALTER TABLE public.booking_destinations
  ADD CONSTRAINT uq_booking_destination_sequence
  UNIQUE (booking_id, sequence_order);

-- 2. Match the index every other booking child already has.
CREATE INDEX IF NOT EXISTS idx_booking_cargo_items_booking_id
  ON public.booking_cargo_items (booking_id);

-- 3. The booking list's ORDER BY, and the client-scoped variant of it. The
--    composite serves the client case; the plain one serves staff, who read the
--    same list unfiltered.
CREATE INDEX IF NOT EXISTS idx_bookings_created_at
  ON public.bookings (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_bookings_client_created_at
  ON public.bookings (client_id, created_at DESC);
