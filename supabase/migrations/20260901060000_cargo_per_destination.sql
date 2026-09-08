-- Record WHICH drop-off each cargo line is for.
--
-- The booking wizard already collects cargo per drop-off — its form is literally
-- organised into a section per destination — and then threw that structure away
-- at submit: every group from every section was flattened into one list against
-- the booking, with no way back. On a three-stop run that discards the single
-- most useful fact about the load, and it is the fact the driver needs at the
-- second stop: which of these pallets come off here.
--
-- Nullable, and ON DELETE SET NULL: cargo booked before this existed has no
-- destination and must stay readable, and removing a drop-off must not silently
-- delete the record of goods that were meant for it.

ALTER TABLE public.booking_cargo_items
  ADD COLUMN IF NOT EXISTS destination_id uuid
  REFERENCES public.booking_destinations(destination_id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_booking_cargo_items_destination_id
  ON public.booking_cargo_items (destination_id)
  WHERE destination_id IS NOT NULL;

COMMENT ON COLUMN public.booking_cargo_items.destination_id IS
  'The drop-off this cargo line is bound for. NULL on bookings taken before cargo was tracked per destination.';
