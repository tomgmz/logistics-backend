-- Document Management in real time (2026-10-25).
--
-- 20260930010000 made the staff uploads, trip pickup photos, trip stop photos and
-- destination proof photos signal live:documents. Four file sources still only
-- signalled their own topics (live:bookings / live:trucks), so the page could
-- only count them into a "new updates" bar or wait for its 60 s re-check:
--   bookings.transaction_documents    the client's attachments
--   bookings.pickup_proof_photo_url   single-trip pickup proof
--   truck_odometer_readings.photo_url odometer photos
--   truck_services.receipt_url        service receipts
-- Each now signals live:documents too, only when its file column changes (the
-- column lists keep every other booking or truck edit off this topic). Separate
-- trigger names, so the existing `live_signal` triggers stay as they are.

DROP TRIGGER IF EXISTS live_signal_documents ON public.bookings;
CREATE TRIGGER live_signal_documents
  AFTER INSERT OR UPDATE OF transaction_documents, pickup_proof_photo_url OR DELETE ON public.bookings
  FOR EACH ROW EXECUTE FUNCTION public.live_signal_trigger('booking_id', 'live:documents');

DROP TRIGGER IF EXISTS live_signal_documents ON public.truck_odometer_readings;
CREATE TRIGGER live_signal_documents
  AFTER INSERT OR UPDATE OF photo_url OR DELETE ON public.truck_odometer_readings
  FOR EACH ROW EXECUTE FUNCTION public.live_signal_trigger('reading_id', 'live:documents');

DROP TRIGGER IF EXISTS live_signal_documents ON public.truck_services;
CREATE TRIGGER live_signal_documents
  AFTER INSERT OR UPDATE OF receipt_url OR DELETE ON public.truck_services
  FOR EACH ROW EXECUTE FUNCTION public.live_signal_trigger('service_id', 'live:documents');
