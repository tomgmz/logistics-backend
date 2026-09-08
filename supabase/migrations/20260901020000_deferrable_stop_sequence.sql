-- Make the stop-order constraint deferrable.
--
-- `uq_booking_destination_sequence` stops two drop-offs sharing a position on
-- the same booking. But route optimisation now runs AFTER the booking is
-- created, off the request path, and re-sequencing means permuting those very
-- values — swapping stop 1 and stop 2 transiently collides, and PostgreSQL
-- checks a non-deferrable unique constraint row by row, so the swap fails even
-- though the end state is perfectly valid.
--
-- INITIALLY IMMEDIATE keeps the ordinary insert path checking as it does today;
-- only the re-sequencing transaction defers the check to COMMIT, where it sees
-- the finished permutation.

ALTER TABLE public.booking_destinations
  DROP CONSTRAINT IF EXISTS uq_booking_destination_sequence;

ALTER TABLE public.booking_destinations
  ADD CONSTRAINT uq_booking_destination_sequence
  UNIQUE (booking_id, sequence_order)
  DEFERRABLE INITIALLY IMMEDIATE;
