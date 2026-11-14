-- A booking where no drop-off was delivered (truck or goods stolen, accident,
-- every client refused) now ends 'failed' instead of 'delivered' (user
-- 2026-11-14). Final like 'cancelled': no client confirmation, no auto-complete.
-- Set only by the server (driverCompleteBookingService); a partial failure stays
-- 'delivered' and is shown as the "Partly failed" tag.
ALTER TABLE public.bookings DROP CONSTRAINT IF EXISTS bookings_status_check;
ALTER TABLE public.bookings ADD CONSTRAINT bookings_status_check
  CHECK (status::text = ANY (ARRAY['pending', 'approved', 'assigned', 'in_transit', 'delivered', 'completed', 'failed', 'cancelled']));
